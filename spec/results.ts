// spec/results.ts — 结果对象与 identity 的类型（docs/PLAN.md §5.7 / §5.8）。
// 每次运行产出一组 BenchResult（JSON），baselines/ 与 results/ 里的文件都遵守它。
// 字段名 snake_case；数值单位写在名字里（_us、_bytes、_words）。

export const RESULT_SCHEMA_VERSION = 1;

export type Host = "sim" | "host-shell" | "so3-virt32" | "so3-virt64";
export type Track = "canonical" | "idiomatic" | "neutral";
export type Framework = "solid" | "vue-vapor" | "octane" | "none";
export type Mode = "full" | "guest-tape" | "native" | "raster";
export type Observer = "measure" | "observe";
export type Iteration = "first" | "steady";
export type PixelFormat = "rgba8" | "argb8" | "rgb565";

/** 六个计时段加两个非计时段；顺序即一帧内的执行顺序。 */
export const STAGES = ["setup", "eval", "js", "jobs", "tick", "draw", "render", "verify"] as const;
export type Stage = (typeof STAGES)[number];
export const TIMED_STAGES: readonly Stage[] = ["eval", "js", "jobs", "tick", "draw", "render"];

/** PC 段：由 bench ELF 的链接 map 生成；kernel 只在 SO3 参考机上出现。 */
export const SEGMENTS = ["quickjs", "core", "raster", "libc", "shell", "kernel"] as const;
export type Segment = (typeof SEGMENTS)[number];

/** 运行身份。任一字段变化都可能意味着新的 baseline namespace（见 §5.8）。 */
export interface Identity {
  pocketjs_commit: string;
  bench_commit: string;
  solid_js_version: string | null;
  vue_runtime_vapor_version: string | null;
  octane_version: string | null;
  adapter_hash: string | null;
  bundle_hash: string | null;
  pak_hash: string | null;
  styles_hash: string | null;
  atlas_hashes: string[];
  quickjs_rev: string;
  quickjs_defines: string[];
  rustc_version: string;
  llvm_version: string;
  c_toolchain: string;
  profile_flags: string[];
  rust_target: string;
  so3_commit: string | null;
  so3_defconfig: string | null;
  musl_version: string | null;
  qemu_version: string | null;
  qemu_machine: string | null;
  qemu_cpu: string | null;
  icount_shift: number | null;
  plugin_version: string | null;
  ref_image_digest: string | null;
  sim_hz: number;
  tick_hz: number;
  viewport: [number, number];
  pixel_format: PixelFormat;
  shell_op_caps: string[];
  arena_limit_bytes: { quickjs: number; core: number };
  ci_runner_class: string | null;
}

export interface SegmentCounts {
  insns: number;
  loads: number;
  stores: number;
  load_bytes: number;
  store_bytes: number;
}

/** 一帧里一个段的样本：host shell 填 cpu_us，参考机填计数与按 PC 段的分解。 */
export interface PhaseSample {
  frame: number;
  stage: Stage;
  cpu_us?: number;
  counts?: SegmentCounts;
  by_segment?: Partial<Record<Segment, SegmentCounts>>;
}

export interface Hashes {
  tree: string;
  drawlist: string;
  fb_rgb565: string | null;
  fb_rgba8: string | null;
}

/** 指标；哪个 host 出哪些字段见 docs/PLAN.md §2 的矩阵。缺席的字段不写，不写 0。 */
export interface Metrics {
  // compile
  bundle_bytes?: number;
  pak_bytes?: number;
  // 启动与 action（host shell，CPU 时间）
  eval_us?: number;
  mount_to_settle_us?: number;
  action_cpu_us?: number;
  jobs_count?: number;
  jobs_us?: number;
  settle_frames?: number;
  // HostOps（所有 host）
  hostops_total?: number;
  hostops_by_type?: Record<string, number>;
  hostops_bytes?: number;
  text_bytes_crossing_boundary?: number;
  boundary_calls?: number;
  nodes_created?: number;
  nodes_destroyed?: number;
  nodes_moved?: number;
  redundant_prop_writes?: number;
  // JS 内存与 GC
  js_peak_bytes?: number;
  js_live_before_gc_bytes?: number;
  js_live_after_gc_bytes?: number;
  gc_runs?: number;
  retained_bytes_per_1000_actions?: number;
  // DrawList 与 damage
  drawlist_words?: number;
  draw_ops_by_type?: Record<string, number>;
  damage_area_px?: number;
  // 参考机（指令数）
  insns_total?: number;
  insns_by_segment?: Partial<Record<Segment, number>>;
  insns_by_stage?: Partial<Record<Stage, number>>;
  loads_total?: number;
  stores_total?: number;
  load_bytes_total?: number;
  store_bytes_total?: number;
  unique_code_lines?: number;
  unique_data_lines?: number;
  code_bytes_by_segment?: Partial<Record<Segment, number>>;
  arena_peak_bytes?: { quickjs: number; core: number };
  min_pass_arena_bytes?: { quickjs: number; core: number };
  stack_high_water_bytes?: number;
}

export interface BenchResult {
  schema_version: typeof RESULT_SCHEMA_VERSION;
  identity: Identity;
  case: string;
  family: string;
  track: Track;
  framework: Framework;
  host: Host;
  profile: string;
  mode: Mode;
  observer: Observer;
  iteration: Iteration;
  metrics: Metrics;
  hashes: Hashes;
  phases: PhaseSample[];
  /** drawlist / fb hash 是否与同一 bundle 的 sim oracle 相等；这是观测结果，不决定运行退出状态。 */
  oracle_match: boolean;
}

/** 对比结果（harness/compare.ts）。参考机指标 exact 为 true 时 delta 必须精确为 0 才算无变化。 */
export interface MetricDelta {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  ratio: number | null;
  exact: boolean;
  ci95?: [number, number];
  flagged: boolean;
}
