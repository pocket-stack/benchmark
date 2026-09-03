// corpus/generate.ts — 中立 MutationTape 生成器。不依赖任何 JS 框架：直接按
// spec/tape.ts 的格式写 FRAME / OP / RET / END 记录，OP / PROP / NODE_TYPE / ENUMS
// 全部从 vendor/pocketjs/contracts/spec/spec.ts 引用，本文件不出现任何 op 数字。
//
//   bun corpus/generate.ts [--out corpus/tapes]
//
// 记录顺序约定（replayer 与 read.ts 共享）：一条 FRAME 记录打开一个虚拟帧，其后直到
// 下一条 FRAME 或 END 的 OP / RET 记录都属于这一帧；出现在第一条 FRAME 之前的记录是
// eval 期（挂载前）的 op。每个 createNode 得到一个确定的 tape-id（从 2 递增，ROOT_ID = 1
// 是核心预建的根），写进紧跟的 RET；replayer 负责 tape-id → live-id 映射。
//
// 限制：中立 corpus 没有 styles.bin 也没有字体 atlas，所以样式只用 setProp，文本
// 只用 setText——文本会被排版但测量宽度为 0（没有 atlas），像素里也没有 glyph。

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { ANALOG_CENTER, ENUMS, NODE_TYPE, OP, PROP, ROOT_ID } from "../vendor/pocketjs/contracts/spec/spec.ts";
import {
  ARG_KIND,
  DEFAULT_VIEWPORT,
  MUTATION_TAPE_HEADER,
  MUTATION_TAPE_MAGIC,
  OP_ARG_LAYOUT,
  RECORD_HEADER,
  RECORD_KIND,
  RET_KIND,
  RETURNING_OP_RET_KIND,
  TAPE_FRAMEWORK,
  TAPE_SOURCE,
  TAPE_VERSION,
  headerWords,
  type ArgKind,
  type RecordedOp,
} from "../spec/tape.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// ---------------------------------------------------------------------------
// word writer
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const scratch = new DataView(new ArrayBuffer(8));

export class WordWriter {
  readonly words: number[] = [];

  u32(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`u32 out of range: ${v}`);
    this.words.push(v >>> 0);
  }

  i32(v: number): void {
    if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new Error(`i32 out of range: ${v}`);
    this.words.push(v >>> 0);
  }

  f32(v: number): void {
    scratch.setFloat32(0, v, true);
    this.words.push(scratch.getUint32(0, true));
  }

  /** 两个 word，低位在前。 */
  f64(v: number): void {
    scratch.setFloat64(0, v, true);
    this.words.push(scratch.getUint32(0, true));
    this.words.push(scratch.getUint32(4, true));
  }

  u64(v: bigint): void {
    this.words.push(Number(v & 0xffffffffn));
    this.words.push(Number((v >> 32n) & 0xffffffffn));
  }

  /** len word + ceil(len/4) 个零填充 word。 */
  bytes(b: Uint8Array): void {
    this.u32(b.length);
    for (let i = 0; i < b.length; i += 4) {
      this.words.push((b[i] | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0);
    }
  }

  str(s: string): void {
    this.bytes(encoder.encode(s));
  }

  arg(kind: ArgKind, value: unknown): void {
    switch (kind) {
      case ARG_KIND.i32:
        return this.i32(value as number);
      case ARG_KIND.u32:
        return this.u32(value as number);
      case ARG_KIND.f32:
        return this.f32(value as number);
      case ARG_KIND.f64:
        return this.f64(value as number);
      case ARG_KIND.str:
        return this.str(value as string);
      case ARG_KIND.blob:
        return this.bytes(value as Uint8Array);
      default:
        throw new Error(`unknown arg kind ${String(kind)}`);
    }
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.words.length * 4);
    const view = new DataView(out.buffer);
    for (let i = 0; i < this.words.length; i++) view.setUint32(i * 4, this.words[i], true);
    return out;
  }
}

// ---------------------------------------------------------------------------
// tape builder
// ---------------------------------------------------------------------------

const OP_NAME_BY_CODE = new Map<number, string>(Object.entries(OP).map(([name, code]) => [code as number, name]));

function recordHeader(kind: number, payloadWords: number): number {
  if (payloadWords > RECORD_HEADER.payloadMaxWords) throw new Error(`record payload too long: ${payloadWords}`);
  return ((payloadWords << RECORD_HEADER.payloadShift) | (kind & RECORD_HEADER.kindMask)) >>> 0;
}

export class TapeBuilder {
  private readonly body = new WordWriter();
  private nextNodeId = ROOT_ID + 1;
  private nextAnimId = 1;
  readonly opCounts = new Map<RecordedOp, number>();
  frames = 0;
  private readonly usedOpCodes = new Set<number>();

  /** 打开一个虚拟帧。 */
  frame(buttons = 0, analog: number = ANALOG_CENTER, ticks = 1): void {
    this.body.u32(recordHeader(RECORD_KIND.frame, 5));
    this.body.u32(this.frames);
    this.body.u32(buttons);
    this.body.u32(analog);
    this.body.u32(ticks);
    this.body.u32(0); // touch_words
    this.frames += 1;
  }

  private emitOp(name: RecordedOp, args: readonly unknown[]): void {
    const layout = OP_ARG_LAYOUT[name] as readonly ArgKind[];
    if (args.length !== layout.length) {
      throw new Error(`${name}: expected ${layout.length} args, got ${args.length}`);
    }
    const payload = new WordWriter();
    payload.u32(OP[name]);
    layout.forEach((kind, i) => payload.arg(kind, args[i]));
    this.body.u32(recordHeader(RECORD_KIND.op, payload.words.length));
    this.body.words.push(...payload.words);
    this.opCounts.set(name, (this.opCounts.get(name) ?? 0) + 1);
    this.usedOpCodes.add(OP[name]);
  }

  private emitRet(kind: number, value: number): void {
    this.body.u32(recordHeader(RECORD_KIND.ret, 2));
    this.body.u32(kind);
    if (kind === RET_KIND.f32) this.body.f32(value);
    else this.body.i32(value);
  }

  createNode(type: number): number {
    const id = this.nextNodeId++;
    this.emitOp("createNode", [type]);
    this.emitRet(RETURNING_OP_RET_KIND.createNode, id);
    return id;
  }

  destroyNode(id: number): void {
    this.emitOp("destroyNode", [id]);
  }

  insertBefore(parent: number, child: number, anchorOr0 = 0): void {
    this.emitOp("insertBefore", [parent, child, anchorOr0]);
  }

  removeChild(parent: number, child: number): void {
    this.emitOp("removeChild", [parent, child]);
  }

  setProp(id: number, propId: number, value: number): void {
    this.emitOp("setProp", [id, propId, value]);
  }

  setText(id: number, text: string): void {
    this.emitOp("setText", [id, text]);
  }

  replaceText(id: number, text: string): void {
    this.emitOp("replaceText", [id, text]);
  }

  animate(id: number, propId: number, to: number, durMs: number, easing: number, delayMs: number): number {
    const animId = this.nextAnimId++;
    this.emitOp("animate", [id, propId, to, durMs, easing, delayMs]);
    this.emitRet(RETURNING_OP_RET_KIND.animate, animId);
    return animId;
  }

  /** 收尾并编码：头部 + 记录流（含 END）。 */
  finish(): Uint8Array {
    const records = this.body.words.slice();
    records.push(recordHeader(RECORD_KIND.end, 0));

    let capsLo = 0;
    let capsHi = 0;
    for (const code of this.usedOpCodes) {
      if (code < 32) capsLo |= 1 << code;
      else if (code < 64) capsHi |= 1 << (code - 32);
      else throw new Error(`op code ${code} does not fit the 64-bit capability bitmap`);
    }

    const header = new WordWriter();
    const values: Record<string, number | bigint> = {
      magic: MUTATION_TAPE_MAGIC,
      version: TAPE_VERSION,
      header_words: headerWords(MUTATION_TAPE_HEADER, { atlas_count: 0 }),
      host_abi: 0,
      source: TAPE_SOURCE.neutral,
      framework: TAPE_FRAMEWORK.none,
      adapter_hash: 0n,
      viewport_w: DEFAULT_VIEWPORT.w,
      viewport_h: DEFAULT_VIEWPORT.h,
      raster_density: 1,
      sim_hz: 60,
      tick_hz: 60,
      bundle_hash: 0n,
      pak_hash: 0n,
      styles_hash: 0n,
      op_caps_lo: capsLo >>> 0,
      op_caps_hi: capsHi >>> 0,
      frame_count: this.frames,
      record_words: records.length,
      atlas_count: 0,
    };
    for (const field of MUTATION_TAPE_HEADER) {
      if (field.kind === "u32") header.u32(values[field.name] as number);
      else if (field.kind === "u64") header.u64(values[field.name] as bigint);
      // u64Array with atlas_count = 0 contributes nothing.
    }
    header.words.push(...records);
    return header.toBytes();
  }
}

// ---------------------------------------------------------------------------
// families
// ---------------------------------------------------------------------------

export interface FamilySpec {
  family: "wide" | "deep" | "list-ops" | "animation";
  scale: number;
  build: (tape: TapeBuilder) => void;
}

/** 彩色小方块的共同样式。 */
function box(tape: TapeBuilder, id: number, w: number, h: number, color: number): void {
  tape.setProp(id, PROP.width, w);
  tape.setProp(id, PROP.height, h);
  tape.setProp(id, PROP.bgColor, color);
}

const PALETTE = [0xff3366cc, 0xffcc6633, 0xff33cc66, 0xff6633cc, 0xffcc3366, 0xff66cc33] as const;

function buildWide(n: number): (tape: TapeBuilder) => void {
  return (tape) => {
    tape.frame();
    for (let i = 0; i < n; i++) {
      const id = tape.createNode(NODE_TYPE.view);
      box(tape, id, 4, 4, PALETTE[i % PALETTE.length]);
      tape.insertBefore(ROOT_ID, id);
    }
    tape.frame();
    tape.frame();
  };
}

function buildDeep(depth: number): (tape: TapeBuilder) => void {
  return (tape) => {
    tape.frame();
    let parent = ROOT_ID;
    for (let level = 1; level <= depth; level++) {
      const id = tape.createNode(NODE_TYPE.view);
      box(tape, id, 480 - level * 4, 272 - level * 2, PALETTE[level % PALETTE.length]);
      tape.setProp(id, PROP.paddingL, 2);
      tape.setProp(id, PROP.paddingT, 1);
      tape.insertBefore(parent, id);
      parent = id;
    }
    tape.frame();
    tape.frame();
  };
}

interface Row {
  id: number;
  cells: [number, number, number];
  key: number;
}

function buildListOps(k: number): (tape: TapeBuilder) => void {
  return (tape) => {
    let nextKey = 1;
    const rows: Row[] = [];

    const makeRow = (): Row => {
      const key = nextKey++;
      const id = tape.createNode(NODE_TYPE.view);
      tape.setProp(id, PROP.flexDir, ENUMS.FlexDir.Row);
      tape.setProp(id, PROP.height, 12);
      tape.setProp(id, PROP.gap, 4);
      const cells = [0, 0, 0].map((_, column) => {
        const text = tape.createNode(NODE_TYPE.text);
        tape.setText(text, column === 0 ? `#${key}` : column === 1 ? `row ${key} label` : "x");
        tape.setProp(text, PROP.textColor, 0xff202020);
        tape.insertBefore(id, text);
        return text;
      }) as [number, number, number];
      return { id, cells, key };
    };

    // frame 0: the list container and K rows
    tape.frame();
    const list = tape.createNode(NODE_TYPE.view);
    tape.setProp(list, PROP.flexDir, ENUMS.FlexDir.Col);
    tape.setProp(list, PROP.width, 480);
    tape.insertBefore(ROOT_ID, list);
    for (let i = 0; i < k; i++) {
      const row = makeRow();
      tape.insertBefore(list, row.id);
      rows.push(row);
    }

    // frame 1: append K/10 rows
    tape.frame();
    for (let i = 0; i < Math.max(1, Math.floor(k / 10)); i++) {
      const row = makeRow();
      tape.insertBefore(list, row.id);
      rows.push(row);
    }

    // frame 2: insert K/10 rows in the middle
    tape.frame();
    {
      const middle = Math.floor(rows.length / 2);
      const anchor = rows[middle];
      const inserted: Row[] = [];
      for (let i = 0; i < Math.max(1, Math.floor(k / 10)); i++) {
        const row = makeRow();
        tape.insertBefore(list, row.id, anchor.id);
        inserted.push(row);
      }
      rows.splice(middle, 0, ...inserted);
    }

    // frame 3: update every 10th row's label
    tape.frame();
    for (let i = 0; i < rows.length; i += 10) {
      tape.replaceText(rows[i].cells[1], `row ${rows[i].key} label !!!`);
    }

    // frame 4: swap rows 1 and length-2 (js-framework-benchmark's swap)
    tape.frame();
    if (rows.length >= 4) {
      const a = 1;
      const b = rows.length - 2;
      const rowA = rows[a];
      const rowB = rows[b];
      const afterB = rows[b + 1];
      tape.insertBefore(list, rowB.id, rowA.id);
      tape.insertBefore(list, rowA.id, afterB ? afterB.id : 0);
      rows[a] = rowB;
      rows[b] = rowA;
    }

    // frame 5: reverse — move each row (in original order) to the front
    tape.frame();
    {
      const original = rows.slice();
      for (const row of original) {
        const first = rows[0];
        tape.insertBefore(list, row.id, first.id === row.id ? rows[1]?.id ?? 0 : first.id);
        rows.splice(rows.indexOf(row), 1);
        rows.unshift(row);
      }
    }

    // frame 6: remove every 10th row (detach, then the sweep's destroy)
    tape.frame();
    {
      const removed: Row[] = [];
      for (let i = 0; i < rows.length; i += 10) removed.push(rows[i]);
      for (const row of removed) tape.removeChild(list, row.id);
      for (const row of removed) tape.destroyNode(row.id);
      for (const row of removed) rows.splice(rows.indexOf(row), 1);
    }

    // frame 7: clear
    tape.frame();
    for (const row of rows) tape.removeChild(list, row.id);
    for (const row of rows) tape.destroyNode(row.id);
    rows.length = 0;

    tape.frame();
    tape.frame();
  };
}

function buildAnimation(n: number): (tape: TapeBuilder) => void {
  return (tape) => {
    tape.frame();
    for (let i = 0; i < n; i++) {
      const id = tape.createNode(NODE_TYPE.view);
      box(tape, id, 8, 8, PALETTE[i % PALETTE.length]);
      tape.setProp(id, PROP.posType, ENUMS.PosType.Absolute);
      tape.setProp(id, PROP.insetL, 0);
      tape.setProp(id, PROP.insetT, (i * 3) % 264);
      tape.insertBefore(ROOT_ID, id);
      tape.animate(id, PROP.translateX, 200 + (i % 7) * 10, 1000, ENUMS.Easing.Linear, 0);
    }
    for (let f = 0; f < 60; f++) tape.frame();
  };
}

export const FAMILIES: readonly FamilySpec[] = [
  ...[10, 100, 1000].map((n) => ({ family: "wide" as const, scale: n, build: buildWide(n) })),
  ...[8, 32, 64].map((d) => ({ family: "deep" as const, scale: d, build: buildDeep(d) })),
  ...[100, 1000].map((k) => ({ family: "list-ops" as const, scale: k, build: buildListOps(k) })),
  ...[10, 100].map((n) => ({ family: "animation" as const, scale: n, build: buildAnimation(n) })),
];

export function buildTape(spec: FamilySpec): { bytes: Uint8Array; tape: TapeBuilder } {
  const tape = new TapeBuilder();
  spec.build(tape);
  return { bytes: tape.finish(), tape };
}

export function tapeFileName(spec: FamilySpec): string {
  return `${spec.family}-${spec.scale}.pkmt`;
}

/** FNV-1a 64 over bytes（与 vendor/pocketjs/hosts/psp/build.rs 一致），hex16。 */
export function fnv1a64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export interface IndexEntry {
  file: string;
  family: string;
  scale: number;
  frames: number;
  record_words: number;
  bytes: number;
  fnv1a64: string;
  ops: Record<string, number>;
}

export function generateAll(outDir: string): IndexEntry[] {
  mkdirSync(outDir, { recursive: true });
  const index: IndexEntry[] = [];
  for (const spec of FAMILIES) {
    const { bytes, tape } = buildTape(spec);
    const file = tapeFileName(spec);
    writeFileSync(join(outDir, file), bytes);
    const recordWords = bytes.length / 4 - headerWords(MUTATION_TAPE_HEADER, { atlas_count: 0 });
    index.push({
      file,
      family: spec.family,
      scale: spec.scale,
      frames: tape.frames,
      record_words: recordWords,
      bytes: bytes.length,
      fnv1a64: fnv1a64(bytes),
      ops: Object.fromEntries([...tape.opCounts.entries()].sort()),
    });
  }
  writeFileSync(join(outDir, "..", "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let out = join(ROOT, "corpus/tapes");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[++i] ?? out);
    else if (argv[i].startsWith("--out=")) out = resolve(argv[i].slice("--out=".length));
  }
  if (!existsSync(join(ROOT, "spec/tape.ts"))) throw new Error("run from the pocketjs-bench repository");
  const index = generateAll(out);
  for (const entry of index) {
    console.log(
      `${entry.file.padEnd(22)} frames=${String(entry.frames).padStart(3)} words=${String(entry.record_words).padStart(7)} bytes=${String(entry.bytes).padStart(8)} ${entry.fnv1a64}`,
    );
  }
  console.log(`corpus: ${index.length} tapes -> ${out}`);
  // Keep the OP name map referenced so a stale spec fails loudly here rather than in read.ts.
  if (!OP_NAME_BY_CODE.has(OP.createNode)) throw new Error("spec OP table lost createNode");
}
