// spec/protocol.ts — case 协议与 shell 输出记录的类型。三方共用：
//   cases/*     实现 globalThis.__bench（BenchCase）
//   shell/      驱动它（C），按 JSONL 输出 ShellRecord
//   harness/    在 wasm oracle 上用同一规则驱动它，并把 JSONL 折成 BenchResult
// 规则文字版见 docs/PROTOCOL.md 与 docs/SHELL.md；本文件是可 import 的常量与类型。

import type { Iteration, Stage } from "./results.ts";

export const BENCH_PROTOCOL_VERSION = 1;

/** Bundle-local typed dispatcher installed by harness/build.ts for canonical cases. */
export const BENCH_HARNESS_GLOBAL = "__pocketHarnessDispatch";
export const BENCH_HARNESS_MOUNT_INDEX = -1;

/** Integer protocol carried by pocket_runtime_harness_call(opcode, argument). */
export const BENCH_HARNESS_OP = {
  ready: 0,
  actionCount: 1,
  actionHash: 2,
  run: 3,
  post: 4,
  hasReset: 5,
  reset: 6,
} as const;

/** mount 阶段用的保留 action 名；case 的 post("mount") 可以直接返回 true。 */
export const MOUNT_ACTION = "mount";

/**
 * settle 规则（两台 host 必须一字不差地实现同一条）：
 * 每帧 render 之后，
 *   1. 若 post(action) 返回 true → 本帧 settle；
 *   2. 否则若本帧 fb hash 与上一帧相等，且这是连续第 STABLE_FRAMES 次相等 → settle；
 *   3. 否则若已跑满 max_settle 帧 → 未 settle（settled=false，settle_frames=max_settle）。
 * settle_frames 计从 action 的第一帧（含）到 settle 帧（含）的帧数。
 */
export const STABLE_FRAMES = 2;
export const DEFAULT_MAX_SETTLE = 120;
export const DEFAULT_WARMUP = 1;

/** case bundle 在 eval 时安装到 globalThis.__bench 的对象。 */
export interface BenchCase {
  version: typeof BENCH_PROTOCOL_VERSION;
  /** 与 case.json 的 id 一致。 */
  case: string;
  /** 按顺序执行；状态在 action 之间延续，除非 reset。 */
  actions: readonly string[];
  /** 发起该 action 的状态变化。在该 action 第一帧的 frame() 之前、同一个 js 段内调用。 */
  run(action: string): void;
  /** 每帧 render 之后询问：postcondition 是否已达到。 */
  post(action: string): boolean;
  /** 可选：回到初始状态（warmup 之后、正式计时之前调用一次）。没有它的 case 只能 warmup=0。 */
  reset?(): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __bench: BenchCase | undefined;
  // eslint-disable-next-line no-var
  var __pocketHarnessDispatch: ((opcode: number, argument: number) => number) | undefined;
}

/** cases/<id>/case.json。 */
export interface CaseManifest {
  id: string;
  family: string;
  /** canonical 是通用 micro workload，idiomatic 是宏场景；都不要求不同框架的实现或结果一致。 */
  track: "canonical" | "idiomatic";
  /** 规模轴（节点数 / 行数 / 扇出数……），写进结果的 case 名：`<id>@<scale>`。 */
  scale?: number;
  frameworks: readonly ("solid" | "vue-vapor" | "octane")[];
  /** 相对 case 目录的入口；变体按 build.ts 规则派生（main.octane.tsx、app.vue-vapor.tsx）。 */
  entry: string;
  actions: readonly string[];
  warmup?: number;
  max_settle?: number;
  description?: string;
}

// ---------------------------------------------------------------------------
// shell 输出（JSON lines）
// ---------------------------------------------------------------------------

export interface IdentityRecord {
  kind: "identity";
  host: "host-shell" | "so3-virt32" | "so3-virt64";
  mode: "full" | "guest-tape" | "native" | "raster";
  observer: "measure" | "observe";
  quickjs_version: string;
  /** SO3/plugin 的逻辑 workload id；旧 host JSONL 可以缺席。 */
  run_id?: number;
  hz: number;
  tick_hz: number;
  viewport: [number, number];
  /** shell 绑定的 op 名（能力集）。 */
  op_caps: string[];
  bundle_hash: string | null;
  pak_hash: string | null;
}

export interface PhaseRecord {
  kind: "phase";
  action: string;
  iteration: Iteration | "warmup";
  /** 启动期的 eval / jobs 段记 -1。 */
  frame: number;
  stage: Stage;
  cpu_us: number;
}

export interface ActionRecord {
  kind: "action";
  action: string;
  iteration: Iteration | "warmup";
  settled: boolean;
  settle_frames: number;
  hashes: {
    /** ui_draw_hash：FNV-1a 64 over DrawList words（LE 字节），hex16。 */
    drawlist: string;
    /** FNV-1a 32 over RGBA8 framebuffer，hex8（与 hosts/sim 一致）。 */
    fb_rgba8: string;
  };
  metrics: {
    hostops_total: number;
    hostops_by_type: Record<string, number>;
    hostops_bytes: number;
    boundary_calls: number;
    nodes_created: number;
    nodes_destroyed: number;
    jobs_count: number;
    drawlist_words: number;
    js_malloc_bytes: number;
    js_malloc_count: number;
    js_peak_bytes: number;
  };
}

export interface EndRecord {
  kind: "end";
  exit: number;
}

export type ShellRecord = IdentityRecord | PhaseRecord | ActionRecord | EndRecord;
