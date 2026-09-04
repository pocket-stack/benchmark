// harness/lib.ts — 各 harness 脚本共用的工具：路径常量、hash、子进程、参数解析、
// case.json 读取、输入 tape 展开、settle 规则的纯函数实现。
//
// settle 规则（docs/PROTOCOL.md）在这里只有一份实现；oracle 用它，测试也用它。
// bench shell（C）必须与这里逐字一致：
//   - `frames` 与 `stable` 在每个 action 开始时归零；
//   - `last`（上一帧 fb hash）跨 action 延续——一个不改画面的 action 第 1 帧就与上一帧相等，
//     第 2 帧再相等即 settle（settle_frames = 2）；mount 之前 last 为空。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { CaseManifest } from "../spec/protocol.ts";
import {
  BENCH_HARNESS_GLOBAL,
  BENCH_HARNESS_MOUNT_INDEX,
  BENCH_HARNESS_OP,
  BENCH_PROTOCOL_VERSION,
  DEFAULT_MAX_SETTLE,
  DEFAULT_WARMUP,
  MOUNT_ACTION,
  STABLE_FRAMES,
} from "../spec/protocol.ts";

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const VENDOR = join(ROOT, "vendor/pocketjs");
export const QUICKJS_RS = join(ROOT, "vendor/quickjs-rs");
export const DIST = join(ROOT, "dist");
export const BUNDLES = join(DIST, "bundles");
export const BUNDLE_INDEX = join(BUNDLES, "index.json");
export const RESULTS = join(ROOT, "results");
export const CASES = join(ROOT, "cases");
export const APPS = join(VENDOR, "apps");
export const WASM_PATH = join(VENDOR, "hosts/web/pocketjs.wasm");
/** case 的构建副本：submodule 的 .gitignore 忽略 .pocket-build/，裸标识符从这里解析到 submodule 的 node_modules。 */
export const STAGING = join(VENDOR, ".pocket-build/bench-cases");
export const HARNESS = join(ROOT, "harness");

export const FRAMEWORKS = ["solid", "vue-vapor", "octane"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

/** 主仓里已有三框架变体的宏 app。 */
export const THREE_VARIANT_APPS = ["cards", "gallery", "hero", "library", "music", "notifications", "settings", "stats"] as const;

export function parseFramework(value: string, source: string): Framework {
  if ((FRAMEWORKS as readonly string[]).includes(value)) return value as Framework;
  throw new Error(`${source}: unknown framework "${value}" (expected ${FRAMEWORKS.join(" | ")})`);
}

export function bundleName(name: string, framework: Framework): string {
  return `${name}.${framework}`;
}

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

/** FNV-1a 32 over bytes, hex8 — hosts/sim/sim.ts fnv1a() 同算法（framebuffer hash）。 */
export function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** FNV-1a 64 over bytes, hex16 — vendor/pocketjs/hosts/psp/build.rs fnv1a64 同算法（身份 hash）。 */
export function fnv1a64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * prime) & mask;
  }
  return u64hex(h);
}

export function u64hex(value: bigint): string {
  return BigInt.asUintN(64, value).toString(16).padStart(16, "0");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(cmd: string, args: readonly string[], cwd: string = ROOT, env: NodeJS.ProcessEnv = process.env): CommandResult {
  const result = Bun.spawnSync({ cmd: [cmd, ...args], cwd, env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function mustRun(label: string, cmd: string, args: readonly string[], cwd: string = ROOT, env: NodeJS.ProcessEnv = process.env): string {
  const result = run(cmd, args, cwd, env);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${label}: ${cmd} ${args.join(" ")} failed (${result.exitCode})${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

/** 命令行版本号；命令不存在时为 null。 */
export function commandVersion(cmd: string, args: readonly string[] = ["--version"]): string | null {
  if (!Bun.which(cmd)) return null;
  const result = run(cmd, args);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim().split("\n")[0] ?? null;
}

export function gitHead(dir: string): string | null {
  const result = run("git", ["-C", dir, "rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

export interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string>;
}

/** `--k=v`、`--k v`、`--k`（布尔，值为 "true"）。 */
export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(a.slice(2), next);
      i++;
    } else flags.set(a.slice(2), "true");
  }
  return { positional, flags };
}

export function flagList(args: Args, name: string): string[] {
  const value = args.flags.get(name);
  if (value === undefined || value === "true") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function wantsHelp(args: Args): boolean {
  return args.flags.has("help") || args.flags.has("h");
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix) && statSync(join(dir, name)).isFile())
    .sort();
}

// ---------------------------------------------------------------------------
// case.json
// ---------------------------------------------------------------------------

export interface ResolvedCase extends CaseManifest {
  warmup: number;
  max_settle: number;
  dir: string;
}

export function readCaseManifest(dir: string): ResolvedCase {
  const path = join(dir, "case.json");
  const manifest = readJson<Partial<CaseManifest>>(path);
  const fail = (what: string): never => {
    throw new Error(`${path}: ${what} (see docs/PROTOCOL.md "case.json")`);
  };
  if (typeof manifest.id !== "string" || !manifest.id) fail("id must be a non-empty string");
  if (typeof manifest.family !== "string" || !manifest.family) fail("family must be a non-empty string");
  if (manifest.track !== "canonical" && manifest.track !== "idiomatic") fail('track must be "canonical" or "idiomatic"');
  if (!Array.isArray(manifest.frameworks) || manifest.frameworks.length === 0) fail("frameworks must be a non-empty array");
  for (const fw of manifest.frameworks) parseFramework(fw, path);
  if (typeof manifest.entry !== "string" || !manifest.entry) fail("entry must name the entry file (e.g. main.tsx)");
  if (!existsSync(join(dir, manifest.entry))) fail(`entry ${manifest.entry} does not exist`);
  if (!Array.isArray(manifest.actions) || manifest.actions.length === 0) fail("actions must be a non-empty array");
  const actions = new Set<string>();
  for (const action of manifest.actions) {
    if (typeof action !== "string" || action.length > 127 || !/^[\x20-\x7e]+$/.test(action) || action.includes(",")) {
      fail("actions must be 1-127 printable ASCII characters without commas");
    }
    if (action === MOUNT_ACTION) fail(`action ${JSON.stringify(MOUNT_ACTION)} is reserved`);
    if (actions.has(action)) fail(`action ${JSON.stringify(action)} is duplicated`);
    actions.add(action);
  }
  if (manifest.scale !== undefined && (!Number.isInteger(manifest.scale) || manifest.scale <= 0)) fail("scale must be a positive integer");
  const warmup = manifest.warmup ?? DEFAULT_WARMUP;
  const maxSettle = manifest.max_settle ?? DEFAULT_MAX_SETTLE;
  if (!Number.isInteger(warmup) || warmup < 0) fail("warmup must be a non-negative integer");
  if (!Number.isInteger(maxSettle) || maxSettle <= 0) fail("max_settle must be a positive integer");
  return { ...(manifest as CaseManifest), warmup, max_settle: maxSettle, dir };
}

/** 结果里的 case 名：`<id>@<scale>`，没有 scale 就是 `<id>`。 */
export function caseResultName(manifest: CaseManifest): string {
  return manifest.scale !== undefined ? `${manifest.id}@${manifest.scale}` : manifest.id;
}

export function listCases(): string[] {
  if (!existsSync(CASES)) return [];
  return readdirSync(CASES)
    .filter((name) => existsSync(join(CASES, name, "case.json")))
    .sort();
}

/**
 * Appended to canonical case bundles after PocketJS build output. The native
 * runtime only transports two int32 arguments and one int32 result; this
 * adapter owns all knowledge of globalThis.__bench and validates the manifest
 * captured at build time before accepting a command.
 */
export function benchHarnessAdapterSource(manifest: Pick<CaseManifest, "id" | "actions">): string {
  const actionHashes = manifest.actions.map((action) => Number.parseInt(fnv1a32(new TextEncoder().encode(action)), 16) >>> 0);
  return `
;(() => {
  const bench = globalThis.__bench;
  const expectedActions = ${JSON.stringify(manifest.actions)};
  const actionHashes = ${JSON.stringify(actionHashes)};
  const ready = !!bench && bench.version === ${BENCH_PROTOCOL_VERSION} && bench.case === ${JSON.stringify(manifest.id)} &&
    Array.isArray(bench.actions) && bench.actions.length === expectedActions.length &&
    expectedActions.every((action, index) => bench.actions[index] === action);
  globalThis[${JSON.stringify(BENCH_HARNESS_GLOBAL)}] = (opcode, argument) => {
    if (!ready) return -1;
    switch (opcode | 0) {
      case ${BENCH_HARNESS_OP.ready}: return ${BENCH_PROTOCOL_VERSION};
      case ${BENCH_HARNESS_OP.actionCount}: return expectedActions.length;
      case ${BENCH_HARNESS_OP.actionHash}: return actionHashes[argument] ?? -1;
      case ${BENCH_HARNESS_OP.run}:
        if (!Number.isInteger(argument) || argument < 0 || argument >= expectedActions.length) return -1;
        bench.run(expectedActions[argument]);
        return 0;
      case ${BENCH_HARNESS_OP.post}:
        if (argument === ${BENCH_HARNESS_MOUNT_INDEX}) return bench.post(${JSON.stringify(MOUNT_ACTION)}) ? 1 : 0;
        if (!Number.isInteger(argument) || argument < 0 || argument >= expectedActions.length) return -1;
        return bench.post(expectedActions[argument]) ? 1 : 0;
      case ${BENCH_HARNESS_OP.hasReset}: return typeof bench.reset === "function" ? 1 : 0;
      case ${BENCH_HARNESS_OP.reset}:
        if (typeof bench.reset !== "function") return -1;
        bench.reset();
        return 0;
      default: return -1;
    }
  };
})();
`;
}

// ---------------------------------------------------------------------------
// 输入 tape
// ---------------------------------------------------------------------------

/**
 * `frame:mask,...` → 每帧一个 mask，每个 mask 从其帧起锁存到下一对为止；
 * 第一对之前的帧读 0。与 vendor/pocketjs/tools/soft.ts expandTape 同语义。
 */
export function expandTape(script: string, frames: number): Uint32Array {
  if (!Number.isInteger(frames) || frames < 0) throw new Error(`expandTape: frames must be a non-negative integer, got ${frames}`);
  const masks = new Uint32Array(frames);
  const pairs = script
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const parts = pair.split(":");
      const frame = Number(parts[0]);
      const mask = Number(parts[1]);
      if (parts.length !== 2 || !Number.isInteger(frame) || frame < 0 || !Number.isInteger(mask) || mask < 0) {
        throw new Error(`expandTape: bad entry "${pair}" (want frame:mask, e.g. 5:0x40)`);
      }
      return { frame, mask };
    });
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i].frame < pairs[i - 1].frame) throw new Error("expandTape: frames must not decrease");
  }
  let current = 0;
  let next = 0;
  for (let f = 0; f < frames; f++) {
    while (next < pairs.length && pairs[next].frame <= f) current = pairs[next++].mask;
    masks[f] = current;
  }
  return masks;
}

// ---------------------------------------------------------------------------
// settle 规则
// ---------------------------------------------------------------------------

export interface SettleState {
  /** 当前 action 已跑的帧数。 */
  frames: number;
  /** 连续与上一帧 fb hash 相等的次数。 */
  stable: number;
  /** 上一帧的 fb hash；跨 action 延续。 */
  last: string | null;
}

export type SettleVerdict = "continue" | "settled" | "exhausted";

export function newSettleState(): SettleState {
  return { frames: 0, stable: 0, last: null };
}

/** 每个 action（含 mount）开始时调用。 */
export function beginAction(state: SettleState): void {
  state.frames = 0;
  state.stable = 0;
}

/** 一帧 render 之后调用一次。 */
export function settleStep(state: SettleState, post: boolean, fbHash: string, maxSettle: number): SettleVerdict {
  state.frames += 1;
  if (post) {
    state.last = fbHash;
    state.stable = 0;
    return "settled";
  }
  if (state.last !== null && fbHash === state.last) state.stable += 1;
  else state.stable = 0;
  state.last = fbHash;
  if (state.stable >= STABLE_FRAMES) return "settled";
  if (state.frames >= maxSettle) return "exhausted";
  return "continue";
}

// ---------------------------------------------------------------------------
// dist/bundles/index.json
// ---------------------------------------------------------------------------

export interface AppTape {
  frames: number;
  input: string;
}

export interface BundleEntry {
  /** `<name>.<framework>`。 */
  bundle: string;
  name: string;
  framework: Framework;
  kind: "case" | "app";
  js: string;
  pak: string;
  js_bytes: number;
  pak_bytes: number;
  js_fnv1a64: string;
  pak_fnv1a64: string;
  js_sha256: string;
  pak_sha256: string;
  /** kind === "case" 时是 case.json（含默认值）。 */
  case: (CaseManifest & { warmup: number; max_settle: number }) | null;
  /** kind === "app" 时是默认输入 tape。 */
  tape: AppTape | null;
}

export interface BundleIndex {
  generated: string;
  pocketjs_commit: string | null;
  bundles: BundleEntry[];
}

export function readBundleIndex(): BundleIndex {
  if (!existsSync(BUNDLE_INDEX)) {
    throw new Error(`${BUNDLE_INDEX} is missing — run \`bun harness/build.ts\` first`);
  }
  return readJson<BundleIndex>(BUNDLE_INDEX);
}

/** `--only a.solid,b.octane` 过滤；空列表表示全部。 */
export function selectBundles(index: BundleIndex, only: readonly string[]): BundleEntry[] {
  if (only.length === 0) return index.bundles;
  const wanted = new Set(only);
  const picked = index.bundles.filter((b) => wanted.has(b.bundle));
  const missing = only.filter((o) => !index.bundles.some((b) => b.bundle === o));
  if (missing.length > 0) {
    throw new Error(`--only names bundles that are not in ${BUNDLE_INDEX}: ${missing.join(", ")} (known: ${index.bundles.map((b) => b.bundle).join(", ")})`);
  }
  return picked;
}

export function readAppTapes(): Record<string, AppTape> {
  return readJson<Record<string, AppTape>>(join(HARNESS, "apps.json"));
}
