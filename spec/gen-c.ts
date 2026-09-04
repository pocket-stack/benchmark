// spec/gen-c.ts — 从 spec/tape.ts 与 vendor/pocketjs 的 OP 表生成 shell 用的 C 头文件与
// op 录制包装：
//   shell/generated/pocket_tape.h   tape 常量、头部 word 偏移、stage id、录制 op 表
//   shell/generated/record_ops.h    #define ui_xxx pb_rec_ui_xxx（用 -include 喂给 pocket_runtime.c）
//   shell/generated/record_ops.c    pb_rec_ui_xxx 包装：按布局录参数，调真函数，录返回值
// 生成物提交进仓库；spec/gen.test.ts 字节比对防漂移。
//
//   bun spec/gen-c.ts            写文件
//   bun spec/gen-c.ts --check    只比对，漂移则退出 1

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OP } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { BENCH_HARNESS_GLOBAL, BENCH_HARNESS_MOUNT_INDEX, BENCH_HARNESS_OP, BENCH_PROTOCOL_VERSION } from "./protocol.ts";
import {
  ACTION_ITERATION,
  DRAWLIST_TAPE_HEADER,
  DRAWLIST_TAPE_MAGIC,
  MUTATION_TAPE_HEADER,
  MUTATION_TAPE_MAGIC,
  OP_ARG_LAYOUT,
  PIXEL_FORMAT,
  RECORD_HEADER,
  RECORD_KIND,
  RETURNING_OP_RET_KIND,
  RETURNING_OPS,
  RET_KIND,
  TAPE_FRAMEWORK,
  TAPE_SOURCE,
  TAPE_VERSION,
  type ArgKind,
  type HeaderField,
  type RecordedOp,
} from "./tape.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "shell/generated");

/** 段 id：与 vendor/pocketjs/engine/quickjs-c/pocket_runtime.h 的 POCKET_BENCH_STAGE_* 同值，再加三个 shell 自己的段。 */
export const STAGES = [
  ["IDLE", 0],
  ["EVAL", 1],
  ["JS", 2],
  ["JOBS", 3],
  ["TICK", 4],
  ["DRAW", 5],
  ["RENDER", 6],
  ["VERIFY", 7],
] as const;

const LAYOUT_CHAR: Record<ArgKind, string> = { i32: "i", u32: "u", f32: "f", f64: "d", str: "s", blob: "b" };

/** 参数在 C 签名里的种类：值参数直接传；blob / str 展开为 (const uint8_t *p, size_t n)。 */
interface CParam {
  name: string;
  ctype: "int32_t" | "uint32_t" | "float" | "double" | "blob" | "str";
}
interface CBinding {
  cfn: string;
  params: readonly CParam[];
  ret: "void" | "int32_t" | "float";
}

/**
 * pocket_runtime.c 实际调用的 C ABI（vendor/pocketjs/engine/ui-cabi/include/pocket_ui_cabi.h）。键是 spec OP 名；
 * 只有这里列出的 op 会被改名录制。wrapText / loadTileTexture 不在 pocket_runtime.c 的绑定表里，
 * debug* 与 svc/video 不属于 bench；它们都不出现在这里。
 */
const C_BINDINGS: Partial<Record<RecordedOp, CBinding>> = {
  createNode: { cfn: "ui_create_node", params: [{ name: "node_type", ctype: "uint32_t" }], ret: "int32_t" },
  destroyNode: { cfn: "ui_destroy_node", params: [{ name: "id", ctype: "int32_t" }], ret: "void" },
  insertBefore: {
    cfn: "ui_insert_before",
    params: [
      { name: "parent", ctype: "int32_t" },
      { name: "child", ctype: "int32_t" },
      { name: "anchor", ctype: "int32_t" },
    ],
    ret: "void",
  },
  removeChild: {
    cfn: "ui_remove_child",
    params: [
      { name: "parent", ctype: "int32_t" },
      { name: "child", ctype: "int32_t" },
    ],
    ret: "void",
  },
  setStyle: {
    cfn: "ui_set_style",
    params: [
      { name: "id", ctype: "int32_t" },
      { name: "style_id", ctype: "int32_t" },
    ],
    ret: "void",
  },
  setProp: {
    cfn: "ui_set_prop",
    params: [
      { name: "id", ctype: "int32_t" },
      { name: "prop", ctype: "uint32_t" },
      { name: "value", ctype: "double" },
    ],
    ret: "void",
  },
  setText: {
    cfn: "ui_set_text",
    params: [
      { name: "id", ctype: "int32_t" },
      { name: "text", ctype: "str" },
    ],
    ret: "void",
  },
  replaceText: {
    cfn: "ui_replace_text",
    params: [
      { name: "id", ctype: "int32_t" },
      { name: "text", ctype: "str" },
    ],
    ret: "void",
  },
  uploadTexture: {
    cfn: "ui_upload_texture",
    params: [
      { name: "bytes", ctype: "blob" },
      { name: "width", ctype: "uint32_t" },
      { name: "height", ctype: "uint32_t" },
      { name: "psm", ctype: "uint32_t" },
    ],
    ret: "int32_t",
  },
  uploadImgEntry: { cfn: "ui_upload_img_entry", params: [{ name: "bytes", ctype: "blob" }], ret: "int32_t" },
  freeTexture: { cfn: "ui_free_texture", params: [{ name: "handle", ctype: "int32_t" }], ret: "void" },
  setImage: {
    cfn: "ui_set_image",
    params: [
      { name: "id", ctype: "int32_t" },
      { name: "texture", ctype: "int32_t" },
    ],
    ret: "void",
  },
  setSprite: {
    cfn: "ui_set_sprite",
    params: [
      { name: "id", ctype: "int32_t" },
      { name: "atlas", ctype: "int32_t" },
      { name: "frames", ctype: "uint32_t" },
      { name: "columns", ctype: "uint32_t" },
      { name: "step", ctype: "uint32_t" },
    ],
    ret: "void",
  },
  animate: {
    cfn: "ui_animate",
    params: [
      { name: "id", ctype: "int32_t" },
      { name: "prop", ctype: "uint32_t" },
      { name: "to", ctype: "double" },
      { name: "duration_ms", ctype: "uint32_t" },
      { name: "easing", ctype: "uint32_t" },
      { name: "delay_ms", ctype: "uint32_t" },
    ],
    ret: "int32_t",
  },
  cancelAnim: { cfn: "ui_cancel_anim", params: [{ name: "animation_id", ctype: "int32_t" }], ret: "void" },
  setFocus: { cfn: "ui_set_focus", params: [{ name: "id", ctype: "int32_t" }], ret: "void" },
  setActive: {
    cfn: "ui_set_active",
    params: [
      { name: "id", ctype: "int32_t" },
      { name: "active", ctype: "int32_t" },
    ],
    ret: "void",
  },
  hitTest: {
    cfn: "ui_hit_test",
    params: [
      { name: "x", ctype: "float" },
      { name: "y", ctype: "float" },
    ],
    ret: "int32_t",
  },
  hitTestBounds: {
    cfn: "ui_hit_test_bounds",
    params: [
      { name: "x", ctype: "float" },
      { name: "y", ctype: "float" },
    ],
    ret: "int32_t",
  },
  setCursor: {
    cfn: "ui_set_cursor",
    params: [
      { name: "texture", ctype: "int32_t" },
      { name: "hot_x", ctype: "float" },
      { name: "hot_y", ctype: "float" },
      { name: "width", ctype: "float" },
      { name: "height", ctype: "float" },
    ],
    ret: "void",
  },
  setCursorPos: {
    cfn: "ui_set_cursor_pos",
    params: [
      { name: "x", ctype: "float" },
      { name: "y", ctype: "float" },
    ],
    ret: "void",
  },
  loadStyles: { cfn: "ui_load_styles", params: [{ name: "bytes", ctype: "blob" }], ret: "int32_t" },
  loadFontAtlas: { cfn: "ui_load_font_atlas", params: [{ name: "bytes", ctype: "blob" }], ret: "int32_t" },
  measureText: {
    cfn: "ui_measure_text",
    params: [
      { name: "text", ctype: "str" },
      { name: "font_slot", ctype: "uint32_t" },
    ],
    ret: "float",
  },
};

function layoutString(op: RecordedOp): string {
  return OP_ARG_LAYOUT[op].map((k) => LAYOUT_CHAR[k]).join("");
}

function headerOffsets(fields: readonly HeaderField[], prefix: string, put: (l?: string) => void): void {
  let offset = 0;
  for (const f of fields) {
    if (f.kind === "u64Array") {
      put(`#define ${prefix}_${f.name.toUpperCase()}_OFFSET ${offset} /* ${f.count} × u64 */`);
      break;
    }
    put(`#define ${prefix}_${f.name.toUpperCase()} ${offset}${f.note ? ` /* ${f.note} */` : ""}`);
    offset += f.kind === "u32" ? 1 : 2;
  }
  put(`#define ${prefix}_FIXED_WORDS ${offset}`);
}

export function generateTapeHeader(): string {
  const lines: string[] = [];
  const put = (l = "") => lines.push(l);
  put("/* Generated by spec/gen-c.ts from spec/tape.ts and vendor/pocketjs/contracts/spec/spec.ts.");
  put(" * Do not edit: run `bun spec/gen-c.ts` and commit the result; spec/gen.test.ts byte-compares it. */");
  put("#ifndef PB_TAPE_H");
  put("#define PB_TAPE_H");
  put();
  put("#include <stdint.h>");
  put();
  put(`#define PB_TAPE_VERSION ${TAPE_VERSION}U`);
  put(`#define PB_MUTATION_TAPE_MAGIC 0x${MUTATION_TAPE_MAGIC.toString(16).toUpperCase()}U /* "PKMT" */`);
  put(`#define PB_DRAWLIST_TAPE_MAGIC 0x${DRAWLIST_TAPE_MAGIC.toString(16).toUpperCase()}U /* "PKDL" */`);
  put();
  put("/* Record header word: bits 0-7 kind, bits 8-31 payload words (not counting the header). */");
  put(`#define PB_RECORD_KIND_MASK 0x${RECORD_HEADER.kindMask.toString(16)}U`);
  put(`#define PB_RECORD_PAYLOAD_SHIFT ${RECORD_HEADER.payloadShift}`);
  put(`#define PB_RECORD_PAYLOAD_MAX 0x${RECORD_HEADER.payloadMaxWords.toString(16)}U`);
  for (const [k, v] of Object.entries(RECORD_KIND)) put(`#define PB_RECORD_${k.toUpperCase()} ${v}U`);
  put();
  put("/* ACTION payload: iteration word, then the name (len + padded words). */");
  for (const [k, v] of Object.entries(ACTION_ITERATION)) put(`#define PB_ACTION_${k.toUpperCase()} ${v}U`);
  put();
  for (const [k, v] of Object.entries(RET_KIND)) put(`#define PB_RET_${k.replace(/([A-Z])/g, "_$1").toUpperCase()} ${v}U`);
  put();
  for (const [k, v] of Object.entries(TAPE_SOURCE)) put(`#define PB_SOURCE_${k.replace(/([A-Z])/g, "_$1").toUpperCase()} ${v}U`);
  for (const [k, v] of Object.entries(TAPE_FRAMEWORK)) put(`#define PB_FRAMEWORK_${k.replace(/([A-Z])/g, "_$1").toUpperCase()} ${v}U`);
  for (const [k, v] of Object.entries(PIXEL_FORMAT)) put(`#define PB_PIXEL_${k.toUpperCase()} ${v}U`);
  put();
  put("/* FRAME payload words. */");
  put("#define PB_FRAME_INDEX 0");
  put("#define PB_FRAME_BUTTONS 1");
  put("#define PB_FRAME_ANALOG 2");
  put("#define PB_FRAME_TICKS 3");
  put("#define PB_FRAME_TOUCH_WORDS 4");
  put("#define PB_FRAME_FIXED_WORDS 5");
  put();
  put("/* MutationTape header word offsets (u64 fields take two words, low first). */");
  headerOffsets(MUTATION_TAPE_HEADER, "PB_MT", put);
  put();
  put("/* DrawListTape header word offsets. */");
  headerOffsets(DRAWLIST_TAPE_HEADER, "PB_DL", put);
  put();
  put("/* Stage ids: 0-4 match POCKET_BENCH_STAGE_* in engine/quickjs-c/pocket_runtime.h. */");
  for (const [name, id] of STAGES) put(`#define PB_STAGE_${name} ${id}`);
  put(`#define PB_STAGE_COUNT ${STAGES.length}`);
  put();
  put("/* Bundle-local typed harness dispatcher (spec/protocol.ts). */");
  put(`#define PB_HARNESS_GLOBAL "${BENCH_HARNESS_GLOBAL}"`);
  put(`#define PB_HARNESS_PROTOCOL_VERSION ${BENCH_PROTOCOL_VERSION}`);
  put(`#define PB_HARNESS_MOUNT_INDEX (${BENCH_HARNESS_MOUNT_INDEX})`);
  for (const [name, id] of Object.entries(BENCH_HARNESS_OP)) {
    put(`#define PB_HARNESS_${name.replace(/([A-Z])/g, "_$1").toUpperCase()} ${id}`);
  }
  put();
  put("/* Recorded ops: layout chars i=i32 u=u32 f=f32 d=f64 s=str b=blob; ret_kind < 0 = no RET record. */");
  put("typedef struct {");
  put("  uint32_t op;");
  put("  const char *name;");
  put("  const char *layout;");
  put("  int ret_kind;");
  put("} PbOpSpec;");
  put();
  const ops = Object.keys(OP_ARG_LAYOUT) as RecordedOp[];
  put(`#define PB_OP_COUNT ${ops.length}`);
  put("static const PbOpSpec PB_OPS[PB_OP_COUNT] = {");
  for (const op of ops) {
    const ret = (RETURNING_OPS as readonly string[]).includes(op) ? RETURNING_OP_RET_KIND[op as (typeof RETURNING_OPS)[number]] : -1;
    put(`  { ${OP[op]}U, "${op}", "${layoutString(op)}", ${ret} },`);
  }
  put("};");
  put();
  put("/* Ops pocket_runtime.c binds and the observe build records (subset of PB_OPS). */");
  const bound = ops.filter((op) => C_BINDINGS[op]);
  put(`#define PB_BOUND_OP_COUNT ${bound.length}`);
  put("static const uint32_t PB_BOUND_OPS[PB_BOUND_OP_COUNT] = {");
  put(`  ${bound.map((op) => `${OP[op]}U`).join(", ")}`);
  put("};");
  put();
  put("#endif");
  return lines.join("\n") + "\n";
}

function cParams(binding: CBinding): string {
  const parts: string[] = [];
  for (const p of binding.params) {
    if (p.ctype === "blob" || p.ctype === "str") parts.push(`const uint8_t *${p.name}, size_t ${p.name}_length`);
    else parts.push(`${p.ctype} ${p.name}`);
  }
  return parts.length ? parts.join(", ") : "void";
}

function cArgs(binding: CBinding): string {
  const parts: string[] = [];
  for (const p of binding.params) {
    if (p.ctype === "blob" || p.ctype === "str") parts.push(`${p.name}, ${p.name}_length`);
    else parts.push(p.name);
  }
  return parts.join(", ");
}

export function generateRecordOpsHeader(): string {
  const lines: string[] = [];
  const put = (l = "") => lines.push(l);
  put("/* Generated by spec/gen-c.ts. Do not edit.");
  put(" * Fed to pocket_runtime.c with `-include` in the observe build: every ui_* call it");
  put(" * makes lands in the pb_rec_ui_* wrapper of record_ops.c, which records the call");
  put(" * and forwards it. record_ops.c itself must NOT include this header. */");
  put("#ifndef PB_RECORD_OPS_H");
  put("#define PB_RECORD_OPS_H");
  for (const [op, binding] of Object.entries(C_BINDINGS) as [RecordedOp, CBinding][]) {
    put(`#define ${binding.cfn} pb_rec_${binding.cfn} /* ${op} */`);
  }
  put("/* setPropBatch is not a spec op: record.c expands it into setProp records. */");
  put("#define ui_set_prop_batch pb_rec_ui_set_prop_batch");
  put("#endif");
  return lines.join("\n") + "\n";
}

export function generateRecordOpsSource(): string {
  const lines: string[] = [];
  const put = (l = "") => lines.push(l);
  put("/* Generated by spec/gen-c.ts. Do not edit. See record_ops.h. */");
  put('#include "pocket_ui_cabi.h"');
  put('#include "../record.h"');
  put();
  for (const [op, binding] of Object.entries(C_BINDINGS) as [RecordedOp, CBinding][]) {
    const layout = OP_ARG_LAYOUT[op];
    if (layout.length !== binding.params.length) {
      throw new Error(`gen-c: ${op} layout has ${layout.length} args but the C binding has ${binding.params.length}`);
    }
    put(`${binding.ret} pb_rec_${binding.cfn}(${cParams(binding)}) {`);
    put(`  pb_record_op_begin(${OP[op]}U);`);
    binding.params.forEach((p, i) => {
      const kind = layout[i];
      switch (kind) {
        case "i32":
          put(`  pb_record_word((uint32_t)${p.name});`);
          break;
        case "u32":
          put(`  pb_record_word((uint32_t)${p.name});`);
          break;
        case "f32":
          put(`  pb_record_f32(${p.name});`);
          break;
        case "f64":
          put(`  pb_record_f64(${p.name});`);
          break;
        case "str":
          put(`  pb_record_bytes(${p.name}, ${p.name}_length, 1);`);
          break;
        case "blob":
          put(`  pb_record_bytes(${p.name}, ${p.name}_length, 0);`);
          break;
      }
    });
    put("  pb_record_op_end();");
    if (binding.ret === "void") {
      put(`  ${binding.cfn}(${cArgs(binding)});`);
    } else {
      put(`  ${binding.ret} result = ${binding.cfn}(${cArgs(binding)});`);
      const ret = (RETURNING_OPS as readonly string[]).includes(op)
        ? RETURNING_OP_RET_KIND[op as (typeof RETURNING_OPS)[number]]
        : -1;
      if (ret === RET_KIND.i32) put("  pb_record_ret_i32(result);");
      else if (ret === RET_KIND.f32) put("  pb_record_ret_f32(result);");
      put("  return result;");
    }
    put("}");
    put();
  }
  return lines.join("\n");
}

/**
 * guest-tape 模式：pocket_runtime.c 的所有 ui_* 调用改名到 pb_tape_ui_*。
 * op 表函数在 tape_ops.c 里生成（锁步比对 + 用 RET 应答）；生命周期与只读
 * 函数（init/tick/render/damage/gl/debug…）由 shell/tape_host.c 手写空转桩，
 * 这里只负责 #define。清单必须覆盖 pocket_runtime.c 引用的每个 ui_* 符号，
 * guest-tape 构建靠这一点保证 core 永远不被触碰。
 */
const TAPE_STUBBED = [
  "ui_init",
  "ui_shutdown",
  "ui_set_viewport",
  "ui_tick",
  "ui_render_incremental",
  "ui_framebuffer_width",
  "ui_framebuffer_height",
  "ui_framebuffer_stride",
  "ui_framebuffer_len",
  "ui_damage_attempts",
  "ui_damage_failures",
  "ui_damage_full_redraws",
  "ui_damage_pixels",
  "ui_damage_bounds",
  "ui_gl_initialize",
  "ui_gl_reset_resources",
  "ui_gl_shutdown",
  "ui_gl_render",
  "ui_debug_inspect",
  "ui_debug_rect_xy",
  "ui_debug_rect_wh",
  "ui_debug_pause",
  "ui_debug_step",
] as const;

export function generateTapeOpsHeader(): string {
  const lines: string[] = [];
  const put = (l = "") => lines.push(l);
  put("/* Generated by spec/gen-c.ts. Do not edit.");
  put(" * Fed to pocket_runtime.c with `-include` in the guest-tape build: every ui_*");
  put(" * call lands in shell/tape_host.c (lockstep match + recorded answers) or a");
  put(" * no-op stub — the core is never touched. tape_ops.c must NOT include this. */");
  put("#ifndef PB_TAPE_OPS_H");
  put("#define PB_TAPE_OPS_H");
  for (const [op, binding] of Object.entries(C_BINDINGS) as [RecordedOp, CBinding][]) {
    put(`#define ${binding.cfn} pb_tape_${binding.cfn} /* ${op} */`);
  }
  put("#define ui_set_prop_batch pb_tape_ui_set_prop_batch");
  for (const name of TAPE_STUBBED) put(`#define ${name} pb_tape_${name}`);
  put("#endif");
  return lines.join("\n") + "\n";
}

export function generateTapeOpsSource(): string {
  const lines: string[] = [];
  const put = (l = "") => lines.push(l);
  put("/* Generated by spec/gen-c.ts. Do not edit. See tape_ops.h. */");
  put('#include "pocket_ui_cabi.h"');
  put('#include "../tape_host.h"');
  put();
  for (const [op, binding] of Object.entries(C_BINDINGS) as [RecordedOp, CBinding][]) {
    const layout = OP_ARG_LAYOUT[op];
    put(`${binding.ret} pb_tape_${binding.cfn}(${cParams(binding)}) {`);
    put(`  pb_tape_op_begin(${OP[op]}U);`);
    binding.params.forEach((p, i) => {
      switch (layout[i]) {
        case "i32":
        case "u32":
          put(`  pb_tape_word((uint32_t)${p.name});`);
          break;
        case "f32":
          put(`  pb_tape_f32(${p.name});`);
          break;
        case "f64":
          put(`  pb_tape_f64(${p.name});`);
          break;
        case "str":
        case "blob":
          put(`  pb_tape_bytes(${p.name}, ${p.name}_length);`);
          break;
      }
    });
    put("  pb_tape_op_end();");
    const ret = (RETURNING_OPS as readonly string[]).includes(op)
      ? RETURNING_OP_RET_KIND[op as (typeof RETURNING_OPS)[number]]
      : -1;
    if (binding.ret === "void") {
      if (ret >= 0) put("  pb_tape_ret_skip();");
    } else if (ret === RET_KIND.i32) {
      put("  return pb_tape_ret_i32();");
    } else if (ret === RET_KIND.f32) {
      put("  return pb_tape_ret_f32();");
    } else {
      put("  return 0;");
    }
    put("}");
    put();
  }
  put("/* setPropBatch: one boundary call, matched as its setProp mutations. */");
  put("void pb_tape_ui_set_prop_batch(const uint8_t *records, size_t length);");
  put("void pb_tape_ui_set_prop_batch(const uint8_t *records, size_t length) {");
  put("  pb_tape_prop_batch(records, length);");
  put("}");
  return lines.join("\n") + "\n";
}

export const OUTPUTS: readonly { path: string; render: () => string }[] = [
  { path: join(OUT_DIR, "pocket_tape.h"), render: generateTapeHeader },
  { path: join(OUT_DIR, "record_ops.h"), render: generateRecordOpsHeader },
  { path: join(OUT_DIR, "record_ops.c"), render: generateRecordOpsSource },
  { path: join(OUT_DIR, "tape_ops.h"), render: generateTapeOpsHeader },
  { path: join(OUT_DIR, "tape_ops.c"), render: generateTapeOpsSource },
];

if (import.meta.main) {
  const check = process.argv.includes("--check");
  let drifted = false;
  mkdirSync(OUT_DIR, { recursive: true });
  for (const out of OUTPUTS) {
    const text = out.render();
    if (check) {
      const current = existsSync(out.path) ? readFileSync(out.path, "utf8") : null;
      if (current !== text) {
        console.error(`gen-c: ${out.path} is out of date — run \`bun spec/gen-c.ts\``);
        drifted = true;
      }
    } else {
      writeFileSync(out.path, text);
      console.log(`gen-c: ${out.path}`);
    }
  }
  if (drifted) process.exit(1);
}
