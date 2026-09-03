// corpus/read.ts — MutationTape 读取器：格式的第二实现，用来交叉验证 generate.ts
// （以及日后 shell / replayer 的录制产物）。只共享 spec/tape.ts 的常量与布局表，不共享
// 编码代码。
//
//   bun corpus/read.ts <file.pkmt> [--dump]
//
// 校验：magic、version、header_words、record_words、文件长度、每条记录的载荷长度、
// op 码可识别且在 OP_ARG_LAYOUT 里、有返回值的 OP 紧跟 RET、END 收尾。

import { readFileSync } from "node:fs";
import { OP } from "../vendor/pocketjs/contracts/spec/spec.ts";
import {
  ARG_KIND,
  MUTATION_TAPE_HEADER,
  MUTATION_TAPE_MAGIC,
  OP_ARG_LAYOUT,
  RECORD_HEADER,
  RECORD_KIND,
  RET_KIND,
  RETURNING_OP_RET_KIND,
  TAPE_VERSION,
  type ArgKind,
  type RecordedOp,
} from "../spec/tape.ts";

const OP_NAME_BY_CODE = new Map<number, string>(Object.entries(OP).map(([name, code]) => [code as number, name]));
const decoder = new TextDecoder();

export interface FrameRecord {
  kind: "frame";
  offset: number;
  frame_index: number;
  buttons: number;
  analog: number;
  ticks: number;
  touch: number[];
}

export interface OpRecord {
  kind: "op";
  offset: number;
  op_code: number;
  op: RecordedOp;
  args: (number | string | Uint8Array)[];
}

export interface RetRecord {
  kind: "ret";
  offset: number;
  ret_kind: number;
  value: number | number[];
}

export interface EndRecord {
  kind: "end";
  offset: number;
}

export type TapeRecord = FrameRecord | OpRecord | RetRecord | EndRecord;

export interface ParsedTape {
  header: Record<string, number | bigint | bigint[]>;
  records: TapeRecord[];
  stats: {
    frames: number;
    ops: Record<string, number>;
    rets: number;
    record_words: number;
  };
}

class WordReader {
  private pos = 0;
  private readonly view: DataView;
  readonly wordCount: number;

  constructor(bytes: Uint8Array) {
    if (bytes.length % 4 !== 0) throw new Error(`tape length ${bytes.length} is not a multiple of 4`);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.wordCount = bytes.length / 4;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.wordCount - this.pos;
  }

  u32(): number {
    if (this.pos >= this.wordCount) throw new Error(`read past end at word ${this.pos}`);
    const v = this.view.getUint32(this.pos * 4, true);
    this.pos += 1;
    return v;
  }

  i32(): number {
    return this.u32() | 0;
  }

  f32(): number {
    if (this.pos >= this.wordCount) throw new Error(`read past end at word ${this.pos}`);
    const v = this.view.getFloat32(this.pos * 4, true);
    this.pos += 1;
    return v;
  }

  f64(): number {
    const lo = this.u32();
    const hi = this.u32();
    const scratch = new DataView(new ArrayBuffer(8));
    scratch.setUint32(0, lo, true);
    scratch.setUint32(4, hi, true);
    return scratch.getFloat64(0, true);
  }

  u64(): bigint {
    const lo = BigInt(this.u32());
    const hi = BigInt(this.u32());
    return lo | (hi << 32n);
  }

  bytes(): Uint8Array {
    const len = this.u32();
    const words = (len + 3) >>> 2;
    const out = new Uint8Array(len);
    for (let w = 0; w < words; w++) {
      const word = this.u32();
      for (let b = 0; b < 4 && w * 4 + b < len; b++) out[w * 4 + b] = (word >>> (8 * b)) & 0xff;
    }
    return out;
  }

  arg(kind: ArgKind): number | string | Uint8Array {
    switch (kind) {
      case ARG_KIND.i32:
        return this.i32();
      case ARG_KIND.u32:
        return this.u32();
      case ARG_KIND.f32:
        return this.f32();
      case ARG_KIND.f64:
        return this.f64();
      case ARG_KIND.str:
        return decoder.decode(this.bytes());
      case ARG_KIND.blob:
        return this.bytes();
      default:
        throw new Error(`unknown arg kind ${String(kind)}`);
    }
  }
}

export function parseTape(bytes: Uint8Array): ParsedTape {
  const r = new WordReader(bytes);
  const header: Record<string, number | bigint | bigint[]> = {};
  for (const field of MUTATION_TAPE_HEADER) {
    if (field.kind === "u32") header[field.name] = r.u32();
    else if (field.kind === "u64") header[field.name] = r.u64();
    else {
      const count = header[field.count ?? ""];
      if (typeof count !== "number") throw new Error(`header: ${field.name} count field ${field.count} missing`);
      const list: bigint[] = [];
      for (let i = 0; i < count; i++) list.push(r.u64());
      header[field.name] = list;
    }
  }
  if (header.magic !== MUTATION_TAPE_MAGIC) throw new Error(`bad magic 0x${(header.magic as number).toString(16)}`);
  if (header.version !== TAPE_VERSION) throw new Error(`unsupported tape version ${String(header.version)}`);
  if (header.header_words !== r.offset) {
    throw new Error(`header_words ${String(header.header_words)} != parsed ${r.offset}`);
  }
  const recordWords = header.record_words as number;
  if (r.remaining !== recordWords) {
    throw new Error(`record_words ${recordWords} != remaining words ${r.remaining}`);
  }

  const records: TapeRecord[] = [];
  const ops: Record<string, number> = {};
  let frames = 0;
  let rets = 0;
  let ended = false;
  let pendingRet: RecordedOp | null = null;
  const recordStart = r.offset;

  while (!ended) {
    const offset = r.offset;
    const head = r.u32();
    const kind = head & RECORD_HEADER.kindMask;
    const payload = head >>> RECORD_HEADER.payloadShift;
    const expectedEnd = r.offset + payload;
    if (expectedEnd > r.wordCount) throw new Error(`record at word ${offset} overruns the tape`);

    if (pendingRet !== null && kind !== RECORD_KIND.ret) {
      throw new Error(`${pendingRet} at word ${offset} is not followed by a RET record`);
    }

    switch (kind) {
      case RECORD_KIND.frame: {
        const frame_index = r.u32();
        const buttons = r.u32();
        const analog = r.u32();
        const ticks = r.u32();
        const touchWords = r.u32();
        const touch: number[] = [];
        for (let i = 0; i < touchWords; i++) touch.push(r.u32());
        if (frame_index !== frames) throw new Error(`frame index ${frame_index} out of order (expected ${frames})`);
        frames += 1;
        records.push({ kind: "frame", offset, frame_index, buttons, analog, ticks, touch });
        break;
      }
      case RECORD_KIND.op: {
        const op_code = r.u32();
        const name = OP_NAME_BY_CODE.get(op_code);
        if (name === undefined) throw new Error(`unknown op code ${op_code} at word ${offset}`);
        const layout = (OP_ARG_LAYOUT as Record<string, readonly ArgKind[] | undefined>)[name];
        if (!layout) throw new Error(`op ${name} (${op_code}) is not a recorded op`);
        const args = layout.map((k) => r.arg(k));
        ops[name] = (ops[name] ?? 0) + 1;
        records.push({ kind: "op", offset, op_code, op: name as RecordedOp, args });
        if (name in RETURNING_OP_RET_KIND) pendingRet = name as RecordedOp;
        break;
      }
      case RECORD_KIND.ret: {
        if (pendingRet === null) throw new Error(`RET at word ${offset} does not follow a returning op`);
        const ret_kind = r.u32();
        const expectedKind = RETURNING_OP_RET_KIND[pendingRet as keyof typeof RETURNING_OP_RET_KIND];
        if (ret_kind !== expectedKind) {
          throw new Error(`RET kind ${ret_kind} for ${pendingRet} (expected ${expectedKind})`);
        }
        let value: number | number[];
        if (ret_kind === RET_KIND.i32) value = r.i32();
        else if (ret_kind === RET_KIND.f32) value = r.f32();
        else if (ret_kind === RET_KIND.u32Array) {
          const len = r.u32();
          value = [];
          for (let i = 0; i < len; i++) value.push(r.u32());
        } else throw new Error(`unknown RET kind ${ret_kind}`);
        rets += 1;
        pendingRet = null;
        records.push({ kind: "ret", offset, ret_kind, value });
        break;
      }
      case RECORD_KIND.end: {
        ended = true;
        records.push({ kind: "end", offset });
        break;
      }
      default:
        throw new Error(`unknown record kind ${kind} at word ${offset}`);
    }
    if (r.offset !== expectedEnd) {
      throw new Error(`record at word ${offset}: payload ${payload} words, consumed ${r.offset - offset - 1}`);
    }
  }
  if (r.remaining !== 0) throw new Error(`${r.remaining} words after END`);
  if (frames !== header.frame_count) throw new Error(`frame_count ${String(header.frame_count)} != ${frames}`);

  return { header, records, stats: { frames, ops, rets, record_words: r.offset - recordStart } };
}

function describe(rec: TapeRecord): string {
  switch (rec.kind) {
    case "frame":
      return `FRAME ${rec.frame_index} buttons=0x${rec.buttons.toString(16)} analog=0x${rec.analog.toString(16)} ticks=${rec.ticks}${rec.touch.length ? ` touch=[${rec.touch.join(",")}]` : ""}`;
    case "op":
      return `OP ${rec.op}(${rec.args.map((a) => (a instanceof Uint8Array ? `<${a.length} bytes>` : JSON.stringify(a))).join(", ")})`;
    case "ret":
      return `RET kind=${rec.ret_kind} ${Array.isArray(rec.value) ? `[${rec.value.join(",")}]` : rec.value}`;
    case "end":
      return "END";
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: bun corpus/read.ts <file.pkmt> [--dump]");
    process.exit(2);
  }
  const parsed = parseTape(new Uint8Array(readFileSync(file)));
  console.log("header:");
  for (const [k, v] of Object.entries(parsed.header)) {
    console.log(`  ${k.padEnd(14)} ${typeof v === "bigint" ? `0x${v.toString(16)}` : Array.isArray(v) ? `[${v.map((x) => `0x${x.toString(16)}`).join(", ")}]` : v}`);
  }
  console.log(`frames: ${parsed.stats.frames}  rets: ${parsed.stats.rets}  record_words: ${parsed.stats.record_words}`);
  console.log("ops:");
  for (const [name, n] of Object.entries(parsed.stats.ops).sort()) console.log(`  ${name.padEnd(16)} ${n}`);
  if (argv.includes("--dump")) {
    for (const rec of parsed.records) console.log(`${String(rec.offset).padStart(8)}  ${describe(rec)}`);
  }
}
