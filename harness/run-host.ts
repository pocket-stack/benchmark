// harness/run-host.ts — 起 bench shell（docs/SHELL.md）跑 index.json 里的 bundle，
// 把它的 JSON lines 折成 spec/results.ts 的 BenchResult，写 results/host/<bundle>.<observer>.json。
//
//   bun harness/run-host.ts --shell dist/shell/host/pocket-bench-shell [--observer measure|observe] [--only a.solid]
//   bun harness/run-host.ts --from-jsonl harness/fixtures/host-shell.sample.jsonl --bundle list-create.solid [--observer observe]
//
// 每个 (action, iteration) 一条 BenchResult（额外带 action 字段）；iteration 为 warmup 的记录不折叠。
// oracle_match：与 results/oracle/<bundle>.json 里同 action、同 iteration 的 drawlist 与 fb_rgba8 都相等。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionRecord, IdentityRecord, PhaseRecord, ShellRecord } from "../spec/protocol.ts";
import { MOUNT_ACTION } from "../spec/protocol.ts";
import {
  RESULT_SCHEMA_VERSION,
  TIMED_STAGES,
  type BenchResult,
  type Identity,
  type Iteration,
  type Metrics,
  type PhaseSample,
  type Stage,
} from "../spec/results.ts";
import { ORACLE_DIR, type OracleAction, type OracleFile } from "./oracle.ts";
import {
  QUICKJS_RS,
  RESULTS,
  ROOT,
  VENDOR,
  type BundleEntry,
  type CommandResult,
  type Framework,
  caseResultName,
  commandVersion,
  ensureDir,
  flagList,
  gitHead,
  parseArgs,
  parseFramework,
  readBundleIndex,
  readJson,
  run,
  selectBundles,
  wantsHelp,
  writeJson,
} from "./lib.ts";

const LABEL = "bench run-host";
export const HOST_DIR = join(RESULTS, "host");
export const HOST_RUN_SCHEMA_VERSION = 1;

export type Observer = "measure" | "observe";

export interface HostBenchResult extends BenchResult {
  action: string;
}

export interface HostRunFile {
  schema_version: typeof HOST_RUN_SCHEMA_VERSION;
  bundle: string;
  name: string;
  framework: Framework;
  kind: "case" | "app";
  observer: Observer;
  shell: string | null;
  jsonl: string | null;
  generated: string;
  identity: Identity;
  results: HostBenchResult[];
}

export interface HostFailure {
  bundle: string;
  observer: Observer;
  exit_code: number;
  stderr: string;
  jsonl: string;
}

function usage(): never {
  console.error(
    "usage: bun harness/run-host.ts --shell <pocket-bench-shell> [--observer measure|observe] [--only a.solid,b.octane]\n" +
      "       bun harness/run-host.ts --from-jsonl <file.jsonl> --bundle <name.framework> [--observer observe]\n" +
      "  runs bundles from dist/bundles/index.json on the shell (or folds an existing JSONL) into results/host/",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------

export function parseJsonl(text: string, source: string): ShellRecord[] {
  const records: ShellRecord[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${i + 1}: not JSON (${(error as Error).message})`);
    }
    const kind = (value as { kind?: unknown }).kind;
    if (kind !== "identity" && kind !== "phase" && kind !== "action" && kind !== "end") {
      throw new Error(`${source}:${i + 1}: unknown record kind ${JSON.stringify(kind)} (see spec/protocol.ts ShellRecord)`);
    }
    records.push(value as ShellRecord);
  }
  if (records.length === 0) throw new Error(`${source}: no records`);
  return records;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

function packageVersion(name: string): string | null {
  const path = join(VENDOR, "node_modules", name, "package.json");
  if (!existsSync(path)) return null;
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function rustcInfo(): { version: string; llvm: string; host: string } {
  const fallback = { version: "unknown", llvm: "unknown", host: "unknown" };
  if (!Bun.which("rustc")) return fallback;
  const result = run("rustc", ["-vV"]);
  if (result.exitCode !== 0) return fallback;
  const field = (key: string): string => result.stdout.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1]?.trim() ?? "unknown";
  return { version: result.stdout.split("\n")[0]?.trim() ?? "unknown", llvm: field("LLVM version"), host: field("host") };
}

export function collectIdentity(record: IdentityRecord, bundle: BundleEntry): Identity {
  const rustc = rustcInfo();
  return {
    pocketjs_commit: gitHead(VENDOR) ?? "unknown",
    bench_commit: gitHead(ROOT) ?? "unknown",
    solid_js_version: packageVersion("solid-js"),
    vue_runtime_vapor_version: packageVersion("@vue/runtime-vapor") ?? packageVersion("vue"),
    octane_version: packageVersion("octane"),
    adapter_hash: null,
    bundle_hash: record.bundle_hash ?? bundle.js_fnv1a64,
    pak_hash: record.pak_hash ?? bundle.pak_fnv1a64,
    styles_hash: null,
    atlas_hashes: [],
    quickjs_rev: gitHead(QUICKJS_RS) ?? record.quickjs_version,
    quickjs_defines: [],
    rustc_version: rustc.version,
    llvm_version: rustc.llvm,
    c_toolchain: commandVersion("cc") ?? "unknown",
    profile_flags: [],
    rust_target: rustc.host,
    so3_commit: null,
    so3_defconfig: null,
    musl_version: null,
    qemu_version: null,
    qemu_machine: null,
    qemu_cpu: null,
    icount_shift: null,
    plugin_version: null,
    ref_image_digest: null,
    sim_hz: record.hz,
    tick_hz: record.tick_hz,
    viewport: record.viewport,
    pixel_format: "rgba8",
    shell_op_caps: record.op_caps,
    arena_limit_bytes: { quickjs: 0, core: 0 },
    ci_runner_class: process.env.BENCH_RUNNER_CLASS ?? null,
  };
}

// ---------------------------------------------------------------------------
// fold
// ---------------------------------------------------------------------------

export interface FoldContext {
  bundle: BundleEntry;
  observer: Observer;
  oracle: OracleFile | null;
  shell: string | null;
  jsonl: string | null;
  /** 测试注入；缺省从环境收集。 */
  identity?: Identity;
}

function oracleActionFor(oracle: OracleFile | null, action: string, iteration: Iteration): OracleAction | null {
  if (!oracle) return null;
  if (action === MOUNT_ACTION) return oracle.mount;
  return oracle.actions.find((a) => a.action === action && a.iteration === iteration) ?? null;
}

export function foldRecords(records: ShellRecord[], ctx: FoldContext): HostRunFile {
  const identityRecord = records.find((r): r is IdentityRecord => r.kind === "identity");
  if (!identityRecord) throw new Error(`${LABEL}: ${ctx.jsonl ?? "records"}: no identity record`);
  const end = records.find((r) => r.kind === "end");
  if (!end) throw new Error(`${LABEL}: ${ctx.jsonl ?? "records"}: no end record — the shell did not finish`);
  if (end.kind === "end" && end.exit !== 0) throw new Error(`${LABEL}: ${ctx.jsonl ?? "records"}: shell exit ${end.exit}`);

  const identity = ctx.identity ?? collectIdentity(identityRecord, ctx.bundle);
  const phases = new Map<string, PhaseRecord[]>();
  for (const record of records) {
    if (record.kind !== "phase" || record.iteration === "warmup") continue;
    const key = `${record.action}\u0000${record.iteration}`;
    const list = phases.get(key) ?? [];
    list.push(record);
    phases.set(key, list);
  }

  const manifest = ctx.bundle.case;
  const results: HostBenchResult[] = [];
  for (const record of records) {
    if (record.kind !== "action" || record.iteration === "warmup") continue;
    const iteration = record.iteration;
    const own = phases.get(`${record.action}\u0000${iteration}`) ?? [];
    const byStage: Partial<Record<Stage, number>> = {};
    for (const phase of own) byStage[phase.stage] = (byStage[phase.stage] ?? 0) + phase.cpu_us;
    let actionCpu = 0;
    for (const stage of TIMED_STAGES) {
      if (stage === "eval") continue;
      actionCpu += byStage[stage] ?? 0;
    }
    const metrics: Metrics = {
      bundle_bytes: ctx.bundle.js_bytes,
      pak_bytes: ctx.bundle.pak_bytes,
      action_cpu_us: actionCpu,
      jobs_count: record.metrics.jobs_count,
      jobs_us: byStage.jobs ?? 0,
      settle_frames: record.settle_frames,
      hostops_total: record.metrics.hostops_total,
      hostops_by_type: record.metrics.hostops_by_type,
      hostops_bytes: record.metrics.hostops_bytes,
      boundary_calls: record.metrics.boundary_calls,
      nodes_created: record.metrics.nodes_created,
      nodes_destroyed: record.metrics.nodes_destroyed,
      drawlist_words: record.metrics.drawlist_words,
      js_peak_bytes: record.metrics.js_peak_bytes,
    };
    if (record.action === MOUNT_ACTION) {
      if (byStage.eval !== undefined) metrics.eval_us = byStage.eval;
      metrics.mount_to_settle_us = actionCpu;
    }
    const expected = oracleActionFor(ctx.oracle, record.action, iteration);
    const oracleMatch =
      expected !== null &&
      expected.hashes.drawlist === record.hashes.drawlist &&
      expected.hashes.fb_rgba8 === record.hashes.fb_rgba8;
    const samples: PhaseSample[] = own.map((p) => ({ frame: p.frame, stage: p.stage, cpu_us: p.cpu_us }));
    results.push({
      schema_version: RESULT_SCHEMA_VERSION,
      identity,
      case: manifest ? caseResultName(manifest) : ctx.bundle.name,
      family: manifest ? manifest.family : "app",
      track: manifest ? manifest.track : "idiomatic",
      framework: ctx.bundle.framework,
      host: identityRecord.host,
      profile: identityRecord.host === "host-shell" ? "host" : identityRecord.host,
      mode: identityRecord.mode,
      observer: identityRecord.observer,
      iteration,
      metrics,
      hashes: { tree: "", drawlist: record.hashes.drawlist, fb_rgba8: record.hashes.fb_rgba8, fb_rgb565: null },
      phases: samples,
      oracle_match: oracleMatch,
      action: record.action,
    });
  }
  if (results.length === 0) throw new Error(`${LABEL}: ${ctx.jsonl ?? "records"}: no action records outside warmup`);
  return {
    schema_version: HOST_RUN_SCHEMA_VERSION,
    bundle: ctx.bundle.bundle,
    name: ctx.bundle.name,
    framework: ctx.bundle.framework,
    kind: ctx.bundle.kind,
    observer: ctx.observer,
    shell: ctx.shell,
    jsonl: ctx.jsonl,
    generated: new Date().toISOString(),
    identity,
    results,
  };
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

export function shellArgs(bundle: BundleEntry, observer: Observer, jsonlPath: string): string[] {
  const args = ["--mode", "full", "--observer", observer, "--js", bundle.js, "--pak", bundle.pak, "--hz", "60", "--out", jsonlPath];
  if (bundle.kind === "case") {
    const manifest = bundle.case!;
    args.push("--bench", "--warmup", String(manifest.warmup), "--max-settle", String(manifest.max_settle));
  } else {
    const tape = bundle.tape ?? { frames: 90, input: "" };
    args.push("--frames", String(tape.frames));
    if (tape.input) args.push("--input", tape.input);
  }
  return args;
}

function loadOracle(bundle: BundleEntry): OracleFile | null {
  const path = join(ORACLE_DIR, `${bundle.bundle}.json`);
  if (!existsSync(path)) {
    console.warn(`${LABEL}: no oracle for ${bundle.bundle} (${path}) — run \`bun harness/oracle.ts\`; oracle_match will be false`);
    return null;
  }
  return readJson<OracleFile>(path);
}

function minimalBundle(name: string, framework: Framework): BundleEntry {
  return {
    bundle: `${name}.${framework}`,
    name,
    framework,
    kind: "app",
    js: "",
    pak: "",
    js_bytes: 0,
    pak_bytes: 0,
    js_fnv1a64: "",
    pak_fnv1a64: "",
    js_sha256: "",
    pak_sha256: "",
    case: null,
    tape: null,
  };
}

export interface RunBundlesHooks {
  execute?: (command: string, args: readonly string[], cwd: string) => CommandResult;
  oracleFor?: (bundle: BundleEntry) => OracleFile | null;
  identity?: Identity;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function runBundles(
  shell: string,
  bundles: readonly BundleEntry[],
  observer: Observer,
  outDir: string,
  hooks: RunBundlesHooks = {},
): { completed: number; failures: HostFailure[]; failurePath: string } {
  const execute = hooks.execute ?? run;
  const oracleFor = hooks.oracleFor ?? loadOracle;
  const log = hooks.log ?? ((message: string) => console.log(message));
  const warn = hooks.warn ?? ((message: string) => console.warn(message));
  const jsonlDir = join(outDir, "jsonl");
  ensureDir(jsonlDir);
  const failures: HostFailure[] = [];
  let completed = 0;
  for (const bundle of bundles) {
    const jsonlPath = join(jsonlDir, `${bundle.bundle}.${observer}.jsonl`);
    const execution = execute(shell, shellArgs(bundle, observer, jsonlPath), ROOT);
    if (execution.exitCode !== 0) {
      const failure = {
        bundle: bundle.bundle,
        observer,
        exit_code: execution.exitCode,
        stderr: execution.stderr.trim(),
        jsonl: jsonlPath,
      } satisfies HostFailure;
      failures.push(failure);
      warn(`${LABEL}: ${bundle.bundle} — FAILED (${execution.exitCode}): ${failure.stderr || "no stderr"}`);
      continue;
    }
    const records = parseJsonl(readFileSync(jsonlPath, "utf8"), jsonlPath);
    const folded = foldRecords(records, {
      bundle,
      observer,
      oracle: oracleFor(bundle),
      shell,
      jsonl: jsonlPath,
      identity: hooks.identity,
    });
    const out = join(outDir, `${bundle.bundle}.${observer}.json`);
    writeJson(out, folded);
    completed += 1;
    const mismatches = folded.results.filter((result) => !result.oracle_match).map((result) => `${result.action}/${result.iteration}`);
    log(
      `${LABEL}: ${bundle.bundle} — ${folded.results.length} result(s), oracle ${mismatches.length === 0 ? "match" : `MISMATCH (${mismatches.join(", ")})`} -> ${out}`,
    );
  }
  const failurePath = join(outDir, `failures.${observer}.json`);
  writeJson(failurePath, { generated: new Date().toISOString(), observer, failures });
  log(`${LABEL}: ${completed}/${bundles.length} bundle(s) completed; ${failures.length} failure(s) -> ${failurePath}`);
  return { completed, failures, failurePath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) usage();
  const observerFlag = args.flags.get("observer") ?? "measure";
  if (observerFlag !== "measure" && observerFlag !== "observe") throw new Error(`${LABEL}: --observer must be measure or observe`);
  const observer: Observer = observerFlag;
  const outDir = args.flags.get("out-dir") ?? HOST_DIR;
  ensureDir(outDir);

  const fromJsonl = args.flags.get("from-jsonl");
  if (fromJsonl) {
    const bundleName = args.flags.get("bundle");
    if (!bundleName || !bundleName.includes(".")) throw new Error(`${LABEL}: --from-jsonl needs --bundle <name.framework>`);
    const dot = bundleName.lastIndexOf(".");
    const name = bundleName.slice(0, dot);
    const framework = parseFramework(bundleName.slice(dot + 1), "--bundle");
    let bundle: BundleEntry;
    try {
      bundle = selectBundles(readBundleIndex(), [bundleName])[0];
    } catch {
      bundle = minimalBundle(name, framework);
    }
    const records = parseJsonl(readFileSync(fromJsonl, "utf8"), fromJsonl);
    const folded = foldRecords(records, { bundle, observer, oracle: loadOracle(bundle), shell: null, jsonl: fromJsonl });
    const out = join(outDir, `${bundle.bundle}.${observer}.json`);
    writeJson(out, folded);
    console.log(`${LABEL}: ${folded.results.length} result(s) -> ${out}`);
    return;
  }

  const shell = args.flags.get("shell");
  if (!shell) usage();
  if (!existsSync(shell)) throw new Error(`${LABEL}: shell ${shell} does not exist — build it (CMakePresets.json, docs/SHELL.md)`);
  const bundles = selectBundles(readBundleIndex(), flagList(args, "only"));
  runBundles(shell, bundles, observer, outDir);
}

if (import.meta.main) await main();
