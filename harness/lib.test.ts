import { describe, expect, test } from "bun:test";
import { STABLE_FRAMES } from "../spec/protocol.ts";
import { beginAction, expandTape, fnv1a32, fnv1a64, newSettleState, parseArgs, settleStep, u64hex } from "./lib.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("hashes", () => {
  test("fnv1a32 matches hosts/sim/sim.ts vectors", () => {
    expect(fnv1a32(bytes(""))).toBe("811c9dc5");
    expect(fnv1a32(bytes("a"))).toBe("e40c292c");
  });
  test("fnv1a64 matches hosts/psp/build.rs vectors", () => {
    expect(fnv1a64(bytes(""))).toBe("cbf29ce484222325");
    expect(fnv1a64(bytes("a"))).toBe("af63dc4c8601ec8c");
  });
  test("u64hex wraps and pads", () => {
    expect(u64hex(0n)).toBe("0000000000000000");
    expect(u64hex(-1n)).toBe("ffffffffffffffff");
  });
});

describe("expandTape", () => {
  test("latches each mask until the next pair", () => {
    const masks = expandTape("5:0x40,6:0,20:0x2000", 25);
    expect(masks[0]).toBe(0);
    expect(masks[4]).toBe(0);
    expect(masks[5]).toBe(0x40);
    expect(masks[6]).toBe(0);
    expect(masks[19]).toBe(0);
    expect(masks[20]).toBe(0x2000);
    expect(masks[24]).toBe(0x2000);
  });
  test("frames before the first pair read zero; empty script is all zero", () => {
    expect(Array.from(expandTape("3:1", 5))).toEqual([0, 0, 0, 1, 1]);
    expect(Array.from(expandTape("", 3))).toEqual([0, 0, 0]);
  });
  test("rejects malformed and decreasing entries", () => {
    expect(() => expandTape("x:1", 2)).toThrow();
    expect(() => expandTape("5:1,3:0", 8)).toThrow();
  });
});

describe("settle rule", () => {
  test("post() settles immediately", () => {
    const s = newSettleState();
    beginAction(s);
    expect(settleStep(s, true, "aaaaaaaa", 120)).toBe("settled");
    expect(s.frames).toBe(1);
  });
  test(`${STABLE_FRAMES} consecutive equal hashes settle; the first frame has no previous hash`, () => {
    const s = newSettleState();
    beginAction(s);
    expect(settleStep(s, false, "a", 120)).toBe("continue");
    expect(settleStep(s, false, "a", 120)).toBe("continue");
    expect(settleStep(s, false, "a", 120)).toBe("settled");
    expect(s.frames).toBe(3);
  });
  test("last hash carries across actions, so a no-op action settles in 2 frames", () => {
    const s = newSettleState();
    beginAction(s);
    settleStep(s, false, "x", 120);
    settleStep(s, false, "y", 120);
    settleStep(s, true, "z", 120);
    beginAction(s);
    expect(s.frames).toBe(0);
    expect(settleStep(s, false, "z", 120)).toBe("continue");
    expect(settleStep(s, false, "z", 120)).toBe("settled");
    expect(s.frames).toBe(2);
  });
  test("a changed hash resets the run", () => {
    const s = newSettleState();
    beginAction(s);
    settleStep(s, false, "a", 120);
    settleStep(s, false, "a", 120);
    expect(settleStep(s, false, "b", 120)).toBe("continue");
    expect(s.stable).toBe(0);
  });
  test("max_settle exhausts", () => {
    const s = newSettleState();
    beginAction(s);
    expect(settleStep(s, false, "1", 3)).toBe("continue");
    expect(settleStep(s, false, "2", 3)).toBe("continue");
    expect(settleStep(s, false, "3", 3)).toBe("exhausted");
  });
});

describe("parseArgs", () => {
  test("supports --k=v, --k v and bare flags", () => {
    const args = parseArgs(["--a=1", "--b", "2", "--c", "--d", "x", "y"]);
    expect(args.flags.get("a")).toBe("1");
    expect(args.flags.get("b")).toBe("2");
    expect(args.flags.get("c")).toBe("true");
    expect(args.flags.get("d")).toBe("x");
    expect(args.positional).toEqual(["y"]);
  });
});
