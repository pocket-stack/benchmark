import type { Identity } from "../../spec/results.ts";
import type { BundleEntry } from "../lib.ts";
import type { HostBenchResult, HostRunFile } from "../run-host.ts";

export const IDENTITY: Identity = {
  pocketjs_commit: "0000000",
  bench_commit: "0000000",
  solid_js_version: "1.9.14",
  vue_runtime_vapor_version: "3.6.0-rc.1",
  octane_version: "0.1.26",
  adapter_hash: null,
  bundle_hash: "00000000deadbeef",
  pak_hash: "00000000cafebabe",
  styles_hash: null,
  atlas_hashes: [],
  quickjs_rev: "ba5bdd0",
  quickjs_defines: [],
  rustc_version: "rustc test",
  llvm_version: "0",
  c_toolchain: "cc test",
  profile_flags: [],
  rust_target: "test",
  so3_commit: null,
  so3_defconfig: null,
  musl_version: null,
  qemu_version: null,
  qemu_machine: null,
  qemu_cpu: null,
  icount_shift: null,
  plugin_version: null,
  ref_image_digest: null,
  sim_hz: 60,
  tick_hz: 60,
  viewport: [480, 272],
  pixel_format: "rgba8",
  shell_op_caps: [],
  arena_limit_bytes: { quickjs: 0, core: 0 },
  ci_runner_class: null,
};

export const BUNDLE: BundleEntry = {
  bundle: "list-create.solid",
  name: "list-create",
  framework: "solid",
  kind: "case",
  js: "/dev/null",
  pak: "/dev/null",
  js_bytes: 1234,
  pak_bytes: 5678,
  js_fnv1a64: "00000000deadbeef",
  pak_fnv1a64: "00000000cafebabe",
  js_sha256: "",
  pak_sha256: "",
  case: {
    id: "list-create",
    family: "list",
    track: "canonical",
    scale: 1000,
    frameworks: ["solid", "vue-vapor", "octane"],
    entry: "main.tsx",
    actions: ["create", "clear"],
    warmup: 1,
    max_settle: 120,
  },
  tape: null,
};

export function hostResult(action: string, cpu: number, hostops: number): HostBenchResult {
  return {
    schema_version: 1,
    identity: IDENTITY,
    case: "list-create@1000",
    family: "list",
    track: "canonical",
    framework: "solid",
    host: "host-shell",
    profile: "host",
    mode: "full",
    observer: "measure",
    iteration: "first",
    metrics: { action_cpu_us: cpu, hostops_total: hostops, settle_frames: 2, nodes_created: 1000 },
    hashes: { tree: "", drawlist: "0", fb_rgba8: "0", fb_rgb565: null },
    phases: [
      { frame: 0, stage: "js", cpu_us: cpu * 0.6 },
      { frame: 0, stage: "draw", cpu_us: cpu * 0.4 },
    ],
    oracle_match: true,
    action,
  };
}

export function hostRun(results: HostBenchResult[]): HostRunFile {
  return {
    schema_version: 1,
    bundle: BUNDLE.bundle,
    name: BUNDLE.name,
    framework: BUNDLE.framework,
    kind: BUNDLE.kind,
    observer: "measure",
    shell: null,
    jsonl: null,
    generated: "",
    identity: IDENTITY,
    results,
  };
}
