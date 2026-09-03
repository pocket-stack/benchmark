// spec/gen.test.ts — 生成物与生成器一致（漂移即失败），布局键集与 OP 表一致。
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OP } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { OUTPUTS } from "./gen-c.ts";
import { generateRust, OUT_PATH } from "./gen-rust.ts";
import { OP_ARG_LAYOUT, RETURNING_OPS } from "./tape.ts";

test("generated C files are committed and current", () => {
  for (const out of OUTPUTS) {
    expect(readFileSync(out.path, "utf8")).toBe(out.render());
  }
});

test("generated Rust file is committed and current", () => {
  expect(readFileSync(OUT_PATH, "utf8")).toBe(generateRust());
});

test("every recorded op is a spec OP and every returning op is recorded", () => {
  for (const name of Object.keys(OP_ARG_LAYOUT)) {
    expect(OP).toHaveProperty(name);
  }
  for (const name of RETURNING_OPS) {
    expect(OP_ARG_LAYOUT).toHaveProperty(name);
  }
});
