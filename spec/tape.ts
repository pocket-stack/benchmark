// spec/tape.ts — MutationTape 与 DrawListTape 的格式。单一事实来源：
// shell/（C）与 crates/pocket-bench（Rust）都不手写这些常量，而是由
// spec/gen-c.ts / spec/gen-rust.ts 从本文件生成（生成物提交进仓库，测试字节比对）。
//
// 第一版草案（P0）。原则：
//   - OP 码只从 vendor/pocketjs/contracts/spec/spec.ts 的 OP 表引用，本文件不出现任何 op 数字。
//   - 记录流是 u32 little-endian words，与 DrawList 同一编码习惯（f32 存 IEEE-754 位，
//     f64 存两个 word：低位在前；字符串是 UTF-8 字节，长度 word + ceil(len/4) 个 word 零填充）。
//   - HostOps 不是单向写流：有返回值的 op（createNode 返 id、measureText 返宽度、hitTest 返
//     命中 id……）在 OP 记录后必须紧跟一条 RET 记录。replayer 用它做 tape-id → live-id 映射，
//     guest-tape 模式的 host 用它应答查询，observe 运行用它断言"录制值 == 真实 core 值"。
//   - op 参数布局以 vendor/pocketjs/framework/src/host.ts 的 HostOps 签名为准；gen-* 落地前
//     会加一条测试把 OP_ARG_LAYOUT 的键集与 OP 表比对。
//   - hash 分两种：framebuffer 用 FNV-1a 32（与 hosts/sim/sim.ts、tools/tape.ts 一致，才能和
//     oracle 逐帧比）；DrawList 用 core 的 ui_draw_hash（FNV-1a 64 over words 的 LE 字节，
//     engine/wasm 与 engine/ui-cabi 同一实现）；头部里的 bundle / pak / styles / atlas 身份
//     hash 用 FNV-1a 64（与 hosts/psp/build.rs 一致）。

import { OP, SCREEN_H, SCREEN_W } from "../vendor/pocketjs/contracts/spec/spec.ts";

export const TAPE_VERSION = 1;

/** 四字节 ASCII → little-endian u32（与 spec.ts 的 PAK_MAGIC 同样算法）。 */
export function fourcc(tag: string): number {
  if (tag.length !== 4) throw new Error(`fourcc: need 4 chars, got ${JSON.stringify(tag)}`);
  return (
    (tag.charCodeAt(0) | (tag.charCodeAt(1) << 8) | (tag.charCodeAt(2) << 16) | (tag.charCodeAt(3) << 24)) >>> 0
  );
}

export const MUTATION_TAPE_MAGIC = fourcc("PKMT");
export const DRAWLIST_TAPE_MAGIC = fourcc("PKDL");

/** 默认 viewport：与 spec.ts 的逻辑分辨率一致，头部仍显式记录。 */
export const DEFAULT_VIEWPORT = { w: SCREEN_W, h: SCREEN_H } as const;

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/** tape 来源。neutral 由 harness/corpus.ts 生成，不依赖 JS。 */
export const TAPE_SOURCE = {
  neutral: 0,
  simRecording: 1, // hosts/sim（Bun + wasm）录制
  shellRecording: 2, // bench shell observe 运行录制
} as const;

export const TAPE_FRAMEWORK = {
  none: 0, // neutral corpus
  solid: 1,
  vueVapor: 2,
  octane: 3,
} as const;

export const PIXEL_FORMAT = {
  rgba8: 0,
  argb8: 1,
  rgb565: 2,
} as const;

/** 记录种类：记录头 word 的 bits 0–7。 */
export const RECORD_KIND = {
  frame: 1, // 一个虚拟帧的边界与输入
  op: 2, // 一次 ui.* 调用
  ret: 3, // 紧跟在有返回值的 OP 后
  end: 4, // 记录流结束
  action: 5, // bench 协议的 run(action) 边界（shell 在 run() 之前写入）
} as const;

/**
 * ACTION 载荷：iteration word（ACTION_ITERATION）+ 名字（len + ceil(len/4)
 * 个零填充 word，UTF-8）。guest-tape 回放据此在同一时刻重新发起
 * `__bench.run(name)`，使 bench 协议的录制也能锁步重放；native replayer
 * 与不认识它的读者按载荷长度跳过即可。
 */
export const ACTION_ITERATION = {
  warmup: 0,
  first: 1,
  steady: 2,
} as const;

/** RET 的值种类。 */
export const RET_KIND = {
  i32: 0, // 节点 id / 纹理 handle / anim id / hitTest 结果
  f32: 1, // measureText 宽度
  u32Array: 2, // wrapText 的断点列（len + words）
} as const;

/** op 参数的编码种类。 */
export const ARG_KIND = {
  i32: "i32", // 1 word
  u32: "u32", // 1 word
  f32: "f32", // 1 word（IEEE-754 位）
  f64: "f64", // 2 words（低位在前）
  str: "str", // len word + ceil(len/4) words（UTF-8，零填充）
  blob: "blob", // len word + ceil(len/4) words（原始字节，零填充）
} as const;
export type ArgKind = (typeof ARG_KIND)[keyof typeof ARG_KIND];

// ---------------------------------------------------------------------------
// 记录布局
// ---------------------------------------------------------------------------

/**
 * 记录头 word：bits 0–7 = RECORD_KIND，bits 8–31 = 载荷 word 数（不含头）。
 * 读者可以按载荷长度跳过不认识的记录。
 */
export const RECORD_HEADER = {
  kindBits: 8,
  kindMask: 0xff,
  payloadShift: 8,
  payloadMaxWords: 0xffffff,
} as const;

type OpName = keyof typeof OP;

/**
 * bench shell 绑定并录制的 op 及其参数布局。键必须是 spec OP 表里的名字。
 * 未列出的 op（debug*、svc*、video*、stream 等）不在 bench 范围内：录制时遇到即失败，
 * 而不是静默丢弃。
 */
export const OP_ARG_LAYOUT = {
  createNode: ["i32"], // (type) → id
  destroyNode: ["i32"],
  insertBefore: ["i32", "i32", "i32"], // (parent, child, anchorOr0)
  removeChild: ["i32", "i32"],
  setStyle: ["i32", "i32"], // (id, styleId)
  setProp: ["i32", "i32", "f64"], // (id, propId, value)
  // setPropBatch 不是 spec op：它是 HostOps 的快速路径，语义是"重复的 setProp"。
  // 录制时展开成 N 条 setProp 记录（boundary_calls 另计），tape 里不出现它。
  setText: ["i32", "str"],
  replaceText: ["i32", "str"],
  uploadTexture: ["blob", "u32", "u32", "u32"], // (buf, w, h, psm) → handle
  setImage: ["i32", "i32"],
  setSprite: ["i32", "i32", "u32", "u32", "u32"], // (id, atlas, frames, cols, step)
  animate: ["i32", "i32", "f64", "u32", "u32", "u32"], // (id, propId, to, durMs, easing, delayMs) → animId
  cancelAnim: ["i32"],
  setFocus: ["i32"],
  setActive: ["i32", "i32"],
  hitTest: ["f32", "f32"], // → id | 0
  hitTestBounds: ["f32", "f32"], // → id | 0
  setCursor: ["i32", "f32", "f32", "f32", "f32"], // (tex, hotX, hotY, w, h)
  setCursorPos: ["f32", "f32"],
  loadStyles: ["blob"],
  loadFontAtlas: ["blob"],
  measureText: ["str", "u32"], // (str, fontSlot) → width f32
  wrapText: ["str", "u32", "f32"], // (str, fontSlot, maxW) → u32[]
  loadTileTexture: ["str", "u32"], // (pakKey, tileIndex) → handle | -1
  freeTexture: ["i32"],
  uploadImgEntry: ["blob"], // → handle | -1
} as const satisfies Partial<Record<OpName, readonly ArgKind[]>>;

export type RecordedOp = keyof typeof OP_ARG_LAYOUT;

/** 有返回值的 op：OP 记录后必须紧跟 RET。 */
export const RETURNING_OPS = [
  "createNode",
  "uploadTexture",
  "animate",
  "measureText",
  "wrapText",
  "hitTest",
  "hitTestBounds",
  "loadTileTexture",
  "uploadImgEntry",
] as const satisfies readonly RecordedOp[];

export const RETURNING_OP_RET_KIND: Record<(typeof RETURNING_OPS)[number], number> = {
  createNode: RET_KIND.i32,
  uploadTexture: RET_KIND.i32,
  animate: RET_KIND.i32,
  measureText: RET_KIND.f32,
  wrapText: RET_KIND.u32Array,
  hitTest: RET_KIND.i32,
  hitTestBounds: RET_KIND.i32,
  loadTileTexture: RET_KIND.i32,
  uploadImgEntry: RET_KIND.i32,
};

// ---------------------------------------------------------------------------
// 头部布局（声明式，gen-* 据此产出结构体偏移）
// ---------------------------------------------------------------------------

export interface HeaderField {
  name: string;
  /** u32 = 1 word；u64 = 2 words（低位在前）；u64Array = count 个 u64，count 取自前面同名字段。 */
  kind: "u32" | "u64" | "u64Array";
  count?: string;
  note?: string;
}

/**
 * MutationTape 头部。header_words 记录头部总长，读者据此跳过将来追加的字段。
 * op_caps_lo/hi：bit i = 录制 host 实现了 op 码 i（可选 op 的有无会切换 guest 代码路径，
 * 所以能力集是 tape 身份的一部分）。
 */
export const MUTATION_TAPE_HEADER: readonly HeaderField[] = [
  { name: "magic", kind: "u32", note: "MUTATION_TAPE_MAGIC" },
  { name: "version", kind: "u32", note: "TAPE_VERSION" },
  { name: "header_words", kind: "u32" },
  { name: "host_abi", kind: "u32", note: "PocketJS __hostAbi" },
  { name: "source", kind: "u32", note: "TAPE_SOURCE" },
  { name: "framework", kind: "u32", note: "TAPE_FRAMEWORK" },
  { name: "adapter_hash", kind: "u64", note: "renderer-*.ts 源码 hash；neutral 为 0" },
  { name: "viewport_w", kind: "u32" },
  { name: "viewport_h", kind: "u32" },
  { name: "raster_density", kind: "u32" },
  { name: "sim_hz", kind: "u32" },
  { name: "tick_hz", kind: "u32" },
  { name: "bundle_hash", kind: "u64" },
  { name: "pak_hash", kind: "u64" },
  { name: "styles_hash", kind: "u64", note: "styles.bin" },
  { name: "op_caps_lo", kind: "u32", note: "op 码 0–31" },
  { name: "op_caps_hi", kind: "u32", note: "op 码 32–63" },
  { name: "frame_count", kind: "u32" },
  { name: "record_words", kind: "u32", note: "记录流总 word 数（含 END）" },
  { name: "atlas_count", kind: "u32" },
  { name: "atlas_hashes", kind: "u64Array", count: "atlas_count", note: "FONT ATLAS blob hash，按 slot 顺序" },
];

/**
 * DrawListTape 头部。正文 = prev_words 个 word（上一份 DrawList）+ cur_words 个 word（当前）。
 * damage 由 backend 层计算：tracker 的快照就是 prev DrawList + 这里的 policy 字段。
 */
export const DRAWLIST_TAPE_HEADER: readonly HeaderField[] = [
  { name: "magic", kind: "u32", note: "DRAWLIST_TAPE_MAGIC" },
  { name: "version", kind: "u32", note: "TAPE_VERSION" },
  { name: "header_words", kind: "u32" },
  { name: "source", kind: "u32", note: "TAPE_SOURCE" },
  { name: "viewport_w", kind: "u32" },
  { name: "viewport_h", kind: "u32" },
  { name: "raster_density", kind: "u32" },
  { name: "pixel_format", kind: "u32", note: "PIXEL_FORMAT" },
  { name: "damage_max_regions", kind: "u32", note: "0 = 全量重绘" },
  { name: "warmup_frames", kind: "u32", note: "计时前先回放的帧数（backend 有状态）" },
  { name: "texture_set_hash", kind: "u64" },
  { name: "expected_fb_hash_rgb565", kind: "u64" },
  { name: "expected_fb_hash_rgba8", kind: "u64" },
  { name: "prev_words", kind: "u32" },
  { name: "cur_words", kind: "u32" },
  {
    name: "base_fb_words",
    kind: "u32",
    note: "0 = 无基底。否则正文在 cur words 之后再跟这么多 word 的 RGBA8 基底帧：最后一帧渲染前的累积画面。半透明 op 沿帧历史混合，只回放 prev+cur 不足以复现像素。",
  },
  { name: "atlas_count", kind: "u32" },
  { name: "atlas_hashes", kind: "u64Array", count: "atlas_count" },
];

export function headerWords(fields: readonly HeaderField[], counts: Record<string, number> = {}): number {
  let words = 0;
  for (const f of fields) {
    if (f.kind === "u32") words += 1;
    else if (f.kind === "u64") words += 2;
    else words += 2 * (counts[f.count ?? ""] ?? 0);
  }
  return words;
}
