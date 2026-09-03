// plugin/segmap.test.ts — a synthetic GNU ld map excerpt exercises the parser:
// object classification, the two-line section form, the raster split by symbol,
// merging and the kernel line.

import { describe, expect, test } from "bun:test";
import { buildSegmap, classifyObject, parseLinkMap, renderSegmap } from "./segmap.ts";

const MAP = `
Archive member included to satisfy reference by file (symbol)

Linker script and memory map

 .text          0x0000000000010000     0x1000 objects/quickjs-quickjs.o
 .text          0x0000000000011000      0x200 objects/main.o
 .text.pocket_runtime_boot
                0x0000000000011200      0x100 objects/pocket_runtime.o
 .text          0x0000000000011300     0x1000 dist/libpocket_bench.a(pocket_bench-abcdef.pocket_bench.0.rcgu.o)
                0x0000000000011300                _ZN12pocketjs_core4tree4Tree6insert17h1234E
                0x0000000000011800                _ZN12pocketjs_core6raster13render_scaled17h5678E
                0x0000000000011c00                _ZN12pocketjs_core4draw4walk17h9abcE
 .text          0x0000000000012300      0x400 /toolchain/lib/libc.a(printf.o)
 .rodata        0x0000000000012700      0x100 objects/main.o
`;

describe("segmap", () => {
  test("classifies objects", () => {
    expect(classifyObject("objects/quickjs-cutils.o")).toBe("quickjs");
    expect(classifyObject("objects/marks_so3.o")).toBe("shell");
    expect(classifyObject("dist/libpocket_bench.a(pocket_bench-1.o)")).toBe("core");
    expect(classifyObject("/x/libc.a(memcpy.o)")).toBe("libc");
    expect(classifyObject("crt1.o")).toBe("libc");
    expect(classifyObject("something.o")).toBe("other");
  });

  test("parses sections and symbols, splits raster by symbol, ignores .rodata", () => {
    const parsed = parseLinkMap(MAP);
    expect(parsed.sections.map((s) => s.segment)).toEqual(["quickjs", "shell", "shell", "core", "libc"]);
    expect(parsed.symbols.length).toBe(3);
    const ranges = buildSegmap(parsed);
    const text = renderSegmap(ranges, 0xffff000000000000n);
    expect(text).toBe(
      [
        "10000 11000 quickjs",
        "11000 11300 shell",
        "11300 11800 core",
        "11800 11c00 raster",
        "11c00 12300 core",
        "12300 12700 libc",
        "kernel ffff000000000000",
      ].join("\n") + "\n",
    );
  });
});
