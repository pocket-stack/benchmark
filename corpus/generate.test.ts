// corpus/generate.test.ts — pin the committed corpus as a benchmark contract,
// then cross-check generation, decoding, topology and per-frame operations.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OP } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { ROOT_ID } from "../vendor/pocketjs/contracts/spec/spec.ts";
import {
  MUTATION_TAPE_HEADER,
  MUTATION_TAPE_MAGIC,
  RETURNING_OPS,
  TAPE_FRAMEWORK,
  TAPE_SOURCE,
  TAPE_VERSION,
  headerWords,
} from "../spec/tape.ts";
import { ROOT } from "../harness/lib.ts";
import { FAMILIES, buildTape, fnv1a64, tapeFileName, type IndexEntry } from "./generate.ts";
import { parseTape, type OpRecord, type ParsedTape } from "./read.ts";

const INDEX = JSON.parse(readFileSync(join(ROOT, "corpus/index.json"), "utf8")) as IndexEntry[];
const EXPECTED_FILES = [
  "wide-10.pkmt",
  "wide-100.pkmt",
  "wide-1000.pkmt",
  "deep-8.pkmt",
  "deep-32.pkmt",
  "deep-64.pkmt",
  "list-ops-100.pkmt",
  "list-ops-1000.pkmt",
  "animation-10.pkmt",
  "animation-100.pkmt",
];

function opRecords(parsed: ParsedTape, name?: string): OpRecord[] {
  return parsed.records.filter((record): record is OpRecord => record.kind === "op" && (name === undefined || record.op === name));
}

function frameOps(parsed: ParsedTape): Array<Record<string, number>> {
  const frames: Array<Record<string, number>> = [];
  let frame = -1;
  for (const record of parsed.records) {
    if (record.kind === "frame") {
      frame = record.frame_index;
      frames[frame] = {};
    } else if (record.kind === "op" && frame >= 0) {
      frames[frame][record.op] = (frames[frame][record.op] ?? 0) + 1;
    }
  }
  return frames;
}

describe("corpus tapes", () => {
  test("the neutral corpus inventory is explicit", () => {
    expect(FAMILIES.map(tapeFileName)).toEqual(EXPECTED_FILES);
    expect(INDEX.map((entry) => entry.file)).toEqual(EXPECTED_FILES);
  });

  for (const spec of FAMILIES) {
    test(spec.family + "-" + spec.scale + " matches its committed tape and index", () => {
      const { bytes, tape } = buildTape(spec);
      const parsed = parseTape(bytes);
      const file = tapeFileName(spec);
      const committed = new Uint8Array(readFileSync(join(ROOT, "corpus/tapes", file)));

      expect(bytes).toEqual(committed);
      expect(parsed.header.magic).toBe(MUTATION_TAPE_MAGIC);
      expect(parsed.header.version).toBe(TAPE_VERSION);
      expect(parsed.header.source).toBe(TAPE_SOURCE.neutral);
      expect(parsed.header.framework).toBe(TAPE_FRAMEWORK.none);
      expect(parsed.header.header_words).toBe(headerWords(MUTATION_TAPE_HEADER, { atlas_count: 0 }));
      expect(parsed.header.frame_count).toBe(tape.frames);
      expect(parsed.stats.frames).toBe(tape.frames);
      expect(bytes.length / 4).toBe((parsed.header.header_words as number) + (parsed.header.record_words as number));
      expect(parsed.stats.record_words).toBe(parsed.header.record_words as number);

      const expectedOps = Object.fromEntries(tape.opCounts.entries());
      expect(parsed.stats.ops).toEqual(expectedOps);
      expect(INDEX.find((entry) => entry.file === file)).toEqual({
        file,
        family: spec.family,
        scale: spec.scale,
        frames: tape.frames,
        record_words: parsed.stats.record_words,
        bytes: bytes.length,
        fnv1a64: fnv1a64(bytes),
        ops: Object.fromEntries([...tape.opCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      });

      // every returning op is immediately followed by a RET, and nothing else is
      let rets = 0;
      for (let i = 0; i < parsed.records.length; i++) {
        const rec = parsed.records[i];
        if (rec.kind === "op" && (RETURNING_OPS as readonly string[]).includes(rec.op)) {
          expect(parsed.records[i + 1]?.kind).toBe("ret");
          rets += 1;
        }
        if (rec.kind === "ret") expect(parsed.records[i - 1]?.kind).toBe("op");
      }
      expect(parsed.stats.rets).toBe(rets);

      // the capability bitmap names exactly the op codes used
      const caps: number[] = [];
      for (let bit = 0; bit < 32; bit++) {
        if (((parsed.header.op_caps_lo as number) >>> bit) & 1) caps.push(bit);
        if (((parsed.header.op_caps_hi as number) >>> bit) & 1) caps.push(bit + 32);
      }
      const used = [...new Set(Object.keys(expectedOps).map((name) => OP[name as keyof typeof OP]))].sort((a, b) => a - b);
      expect(caps).toEqual(used);

      // last record is END, first is FRAME 0 (the neutral corpus has no eval-time ops)
      expect(parsed.records.at(-1)?.kind).toBe("end");
      expect(parsed.records[0]?.kind).toBe("frame");
    });
  }

  test("wide and deep families retain different topology", () => {
    for (const spec of FAMILIES.filter((entry) => entry.family === "wide" || entry.family === "deep")) {
      const parsed = parseTape(buildTape(spec).bytes);
      const inserts = opRecords(parsed, "insertBefore").map((record) => record.args);
      const expected = Array.from({ length: spec.scale }, (_, index) => [
        spec.family === "wide" || index === 0 ? ROOT_ID : index + 1,
        index + 2,
        0,
      ]);
      expect(inserts).toEqual(expected);
      expect(frameOps(parsed)).toEqual([
        {
          createNode: spec.scale,
          setProp: spec.scale * (spec.family === "wide" ? 3 : 5),
          insertBefore: spec.scale,
        },
        {},
        {},
      ]);
    }
  });

  test("list workloads pin every structural phase", () => {
    for (const spec of FAMILIES.filter((entry) => entry.family === "list-ops")) {
      const k = spec.scale;
      const parsed = parseTape(buildTape(spec).bytes);
      expect(frameOps(parsed)).toEqual([
        { createNode: 4 * k + 1, setProp: 6 * k + 2, insertBefore: 4 * k + 1, setText: 3 * k },
        { createNode: 0.4 * k, setProp: 0.6 * k, setText: 0.3 * k, insertBefore: 0.4 * k },
        { createNode: 0.4 * k, setProp: 0.6 * k, setText: 0.3 * k, insertBefore: 0.4 * k },
        { replaceText: 0.12 * k },
        { insertBefore: 2 },
        { insertBefore: 1.2 * k },
        { removeChild: 0.12 * k, destroyNode: 0.12 * k },
        { removeChild: 1.08 * k, destroyNode: 1.08 * k },
        {},
        {},
      ]);
    }
  });

  test("animation workloads keep one tween per node and 60 tick frames", () => {
    for (const spec of FAMILIES.filter((entry) => entry.family === "animation")) {
      const parsed = parseTape(buildTape(spec).bytes);
      expect(frameOps(parsed)).toEqual([
        { createNode: spec.scale, setProp: 6 * spec.scale, insertBefore: spec.scale, animate: spec.scale },
        ...Array.from({ length: 60 }, () => ({})),
      ]);
    }
  });

  test("a corrupted tape is rejected", () => {
    const { bytes } = buildTape(FAMILIES[0]);
    const broken = bytes.slice();
    broken[0] ^= 0xff; // magic
    expect(() => parseTape(broken)).toThrow(/magic/);
    const truncated = bytes.slice(0, bytes.length - 4);
    expect(() => parseTape(truncated)).toThrow(/record_words/);
  });
});
