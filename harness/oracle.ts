// harness/oracle.ts — 在 wasm oracle（vendor/pocketjs/hosts/web/wasm-ops.js，golden 用的那一个）
// 上跑 dist/bundles/index.json 里的 bundle，产出 results/oracle/<bundle>.json：
// mount 与每个 action 在 settle 帧的 DrawList hash 与 framebuffer hash，加 op 计数。
// 每个 bundle 独立产出观测基准；其他 host 的同一 bundle 与它对照，不做跨框架结果约束。
//
//   bun harness/oracle.ts                          index.json 里的全部 bundle
//   bun harness/oracle.ts --only hero.solid,list-create.octane
//   bun harness/oracle.ts --frames 120 --input "5:0x40,6:0"   宏 app 覆盖 harness/apps.json 的默认 tape
//
// case 按 docs/PROTOCOL.md 驱动：eval → mount settle → warmup × K → reset → first → steady（有 reset 才做）。
// settle 规则是 harness/lib.ts 的 settleStep，一字不差。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createWasmUi } from "../vendor/pocketjs/hosts/web/wasm-ops.js";
import { BENCH_PROTOCOL_VERSION, MOUNT_ACTION, type BenchCase } from "../spec/protocol.ts";
import {
  RESULTS,
  VENDOR,
  WASM_PATH,
  type BundleEntry,
  beginAction,
  expandTape,
  flagList,
  fnv1a32,
  mustRun,
  newSettleState,
  parseArgs,
  readBundleIndex,
  selectBundles,
  settleStep,
  u64hex,
  wantsHelp,
  writeJson,
} from "./lib.ts";

const LABEL = "bench oracle";
export const ORACLE_DIR = join(RESULTS, "oracle");
export const ORACLE_SCHEMA_VERSION = 1;

export interface OracleHashes {
  drawlist: string;
  fb_rgba8: string;
}

export interface OracleCounters {
  hostops_total: number;
  hostops_by_type: Record<string, number>;
  boundary_calls: number;
  nodes_created: number;
  nodes_destroyed: number;
}

export interface OracleAction {
  action: string;
  iteration: "first" | "steady";
  settle_frames: number;
  settled: boolean;
  hashes: OracleHashes;
  metrics: OracleCounters;
}

export interface OracleFile {
  schema_version: typeof ORACLE_SCHEMA_VERSION;
  bundle: string;
  name: string;
  framework: string;
  kind: "case" | "app";
  generated: string;
  hz: number;
  viewport: [number, number];
  mount: OracleAction | null;
  actions: OracleAction[];
  /** 宏 app：每帧 fb hash，定位分歧帧用。 */
  frame_hashes?: string[];
}

function usage(): never {
  console.error(
    'usage: bun harness/oracle.ts [--only a.solid,b.octane] [--frames N --input "f:mask,..."]\n' +
      "  runs every selected bundle on the wasm oracle and writes results/oracle/<bundle>.json",
  );
  process.exit(2);
}

function ensureWasm(): void {
  if (existsSync(WASM_PATH)) return;
  console.log(`${LABEL}: ${WASM_PATH} is missing — building it (bun tools/wasm.ts)`);
  mustRun(LABEL, process.execPath, [join(VENDOR, "tools/wasm.ts")], VENDOR);
}

interface Counters extends OracleCounters {
  reset(): void;
  snapshot(): OracleCounters;
}

function makeCounters(): Counters {
  const c: Counters = {
    hostops_total: 0,
    hostops_by_type: {},
    boundary_calls: 0,
    nodes_created: 0,
    nodes_destroyed: 0,
    reset() {
      c.hostops_total = 0;
      c.hostops_by_type = {};
      c.boundary_calls = 0;
      c.nodes_created = 0;
      c.nodes_destroyed = 0;
    },
    snapshot() {
      return {
        hostops_total: c.hostops_total,
        hostops_by_type: { ...c.hostops_by_type },
        boundary_calls: c.boundary_calls,
        nodes_created: c.nodes_created,
        nodes_destroyed: c.nodes_destroyed,
      };
    },
  };
  return c;
}

/** 数每一次 ui.* 调用；setPropBatch 一次调用算 1 次 boundary call、N 次 mutation。 */
function countingOps<T extends object>(ops: T, counters: Counters): T {
  return new Proxy(ops, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || typeof key !== "string") return value;
      return (...argv: unknown[]) => {
        counters.boundary_calls += 1;
        let mutations = 1;
        if (key === "setPropBatch") {
          const buffer = argv[0] as ArrayBuffer;
          mutations = Math.max(1, Math.floor(buffer.byteLength / 24));
        }
        counters.hostops_total += mutations;
        counters.hostops_by_type[key] = (counters.hostops_by_type[key] ?? 0) + mutations;
        if (key === "createNode") counters.nodes_created += 1;
        if (key === "destroyNode") counters.nodes_destroyed += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, argv);
      };
    },
  });
}

type FrameFn = (buttons: number, analog?: number, touches?: readonly number[], hits?: readonly number[]) => void;

interface World {
  frame: FrameFn;
  tick(): void;
  render(): Uint8Array;
  drawHash(): string;
  counters: Counters;
}

async function evalBundle(bundle: BundleEntry, wasmBytes: ArrayBuffer): Promise<{ world: World; bench: BenchCase | undefined }> {
  const wasm = await createWasmUi(wasmBytes);
  if (!wasm.drawHash) throw new Error(`${LABEL}: this pocketjs.wasm has no ui_draw_hash — rebuild it: bun vendor/pocketjs/tools/wasm.ts`);
  const counters = makeCounters();
  const g = globalThis as Record<string, unknown>;
  g.ui = countingOps(wasm.ops, counters);
  g.__pak = await Bun.file(bundle.pak).arrayBuffer();
  g.frame = undefined;
  g.__bench = undefined;
  (0, eval)(await Bun.file(bundle.js).text());
  const frame = g.frame as FrameFn | undefined;
  if (typeof frame !== "function") {
    throw new Error(`${LABEL}: ${bundle.bundle} did not install globalThis.frame (does the entry call mount()/render()?)`);
  }
  const bench = g.__bench as BenchCase | undefined;
  return {
    world: {
      frame,
      tick: () => wasm.tick(),
      render: () => wasm.render(),
      drawHash: () => u64hex(BigInt(wasm.drawHash!())),
      counters,
    },
    bench,
  };
}

function releaseBundle(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.ui;
  delete g.__pak;
  g.frame = undefined;
  g.__bench = undefined;
}

async function runCase(bundle: BundleEntry, world: World, bench: BenchCase | undefined): Promise<Pick<OracleFile, "mount" | "actions">> {
  const manifest = bundle.case!;
  if (!bench) throw new Error(`${LABEL}: ${bundle.bundle} did not install globalThis.__bench (docs/PROTOCOL.md)`);
  if (bench.version !== BENCH_PROTOCOL_VERSION) {
    throw new Error(`${LABEL}: ${bundle.bundle} speaks protocol v${bench.version}, harness speaks v${BENCH_PROTOCOL_VERSION}`);
  }
  if (bench.case !== manifest.id) throw new Error(`${LABEL}: ${bundle.bundle} says case "${bench.case}", case.json says "${manifest.id}"`);
  if (JSON.stringify(bench.actions) !== JSON.stringify(manifest.actions)) {
    throw new Error(`${LABEL}: ${bundle.bundle} actions ${JSON.stringify(bench.actions)} differ from case.json ${JSON.stringify(manifest.actions)}`);
  }
  if (manifest.warmup > 0 && typeof bench.reset !== "function") {
    throw new Error(`${LABEL}: ${bundle.bundle} declares warmup=${manifest.warmup} but __bench has no reset()`);
  }

  const state = newSettleState();
  const settle = async (action: string, iteration: "first" | "steady"): Promise<OracleAction> => {
    beginAction(state);
    // mount 的 op 从 eval 起累计（树是在 bundle 的 IIFE 里建的）；其余 action 从 run() 前归零。
    if (action !== MOUNT_ACTION) world.counters.reset();
    let settled = false;
    let fbHash = "";
    for (;;) {
      world.frame(0);
      // The QuickJS host drains its job queue right after frame(); promise
      // jobs (Vue's scheduler, queueMicrotask polyfills) must run here too,
      // before the tick, or the two hosts diverge.
      await drainJobs();
      world.tick();
      fbHash = fnv1a32(world.render());
      const verdict = settleStep(state, bench.post(action), fbHash, manifest.max_settle);
      if (verdict === "settled") {
        settled = true;
        break;
      }
      if (verdict === "exhausted") break;
    }
    return {
      action,
      iteration,
      settle_frames: state.frames,
      settled,
      hashes: { drawlist: world.drawHash(), fb_rgba8: fbHash },
      metrics: world.counters.snapshot(),
    };
  };

  const mount = await settle(MOUNT_ACTION, "first");
  for (let k = 0; k < manifest.warmup; k++) {
    for (const action of manifest.actions) {
      bench.run(action);
      await settle(action, "first");
    }
    bench.reset!();
  }
  const actions: OracleAction[] = [];
  for (const action of manifest.actions) {
    bench.run(action);
    actions.push(await settle(action, "first"));
  }
  if (typeof bench.reset === "function") {
    for (const action of manifest.actions) {
      bench.run(action);
      actions.push(await settle(action, "steady"));
    }
  }
  return { mount, actions };
}

/** Let queued promise jobs run — the wasm host's equivalent of JS_ExecutePendingJob after frame(). */
function drainJobs(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function runApp(bundle: BundleEntry, world: World, frames: number, input: string): Promise<Pick<OracleFile, "mount" | "actions" | "frame_hashes">> {
  const masks = expandTape(input, frames);
  const frameHashes: string[] = [];
  // 宏 app 的 op 计数从 eval 起累计：挂载发生在 bundle 的 IIFE 里，不是第一帧。
  for (let f = 0; f < frames; f++) {
    world.frame(masks[f]);
    await drainJobs();
    world.tick();
    frameHashes.push(fnv1a32(world.render()));
  }
  return {
    mount: null,
    actions: [
      {
        action: "tape",
        iteration: "first",
        settle_frames: frames,
        settled: true,
        hashes: { drawlist: world.drawHash(), fb_rgba8: frameHashes[frames - 1] ?? fnv1a32(world.render()) },
        metrics: world.counters.snapshot(),
      },
    ],
    frame_hashes: frameHashes,
  };
}

export async function runOracle(bundle: BundleEntry, wasmBytes: ArrayBuffer, override?: { frames?: number; input?: string }): Promise<OracleFile> {
  const { world, bench } = await evalBundle(bundle, wasmBytes);
  try {
    const base = {
      schema_version: ORACLE_SCHEMA_VERSION,
      bundle: bundle.bundle,
      name: bundle.name,
      framework: bundle.framework,
      kind: bundle.kind,
      generated: new Date().toISOString(),
      hz: 60,
      viewport: [480, 272] as [number, number],
    };
    if (bundle.kind === "case") return { ...base, ...(await runCase(bundle, world, bench)) };
    const frames = override?.frames ?? bundle.tape?.frames ?? 90;
    const input = override?.input ?? bundle.tape?.input ?? "";
    return { ...base, ...(await runApp(bundle, world, frames, input)) };
  } finally {
    releaseBundle();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) usage();
  const index = readBundleIndex();
  const bundles = selectBundles(index, flagList(args, "only"));
  const override = {
    frames: args.flags.has("frames") ? Number(args.flags.get("frames")) : undefined,
    input: args.flags.has("input") ? args.flags.get("input") : undefined,
  };
  if (override.frames !== undefined && (!Number.isInteger(override.frames) || override.frames <= 0)) {
    throw new Error(`${LABEL}: --frames wants a positive integer`);
  }
  ensureWasm();
  const wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();
  for (const bundle of bundles) {
    const result = await runOracle(bundle, wasmBytes, override);
    const out = join(ORACLE_DIR, `${bundle.bundle}.json`);
    writeJson(out, result);
    const last = result.actions[result.actions.length - 1];
    console.log(
      `${LABEL}: ${bundle.bundle} — ${result.actions.length} action(s), last ${last?.action}=${last?.hashes.fb_rgba8}` +
        (result.mount ? `, mount ${result.mount.settle_frames} frame(s)` : "") +
        ` -> ${out}`,
    );
  }
}

if (import.meta.main) await main();
