// plugin/segmap.ts — turn a GNU ld link map (`-Wl,-Map=shell.map`) of the bench
// shell into the segmap the pocketcount plugin reads:
//
//   <start_hex> <end_hex> <segment>      one line per code range, sorted, merged
//   kernel <hex>                          PCs at or above this address are the kernel
//
//   bun plugin/segmap.ts dist/shell/so3-aarch64/shell.map --out dist/shell/so3-aarch64/segmap.txt \
//       [--kernel-base 0xffff000000000000]
//
// Only executable sections (.text*) matter: the plugin attributes an instruction
// (and the memory accesses it performs) to the segment of its PC. Object files
// classify by name; the Rust static library links with LTO into one object, so
// the raster / core split inside it comes from symbol addresses (any symbol whose
// name contains `raster` — `pocketjs_core::raster::…` mangled or demangled — owns
// the range up to the next symbol).

import { readFileSync, writeFileSync } from "node:fs";

type Segment = "quickjs" | "core" | "raster" | "libc" | "shell" | "other";

interface Range {
  start: bigint;
  end: bigint;
  segment: Segment;
}

export function classifyObject(file: string): Segment {
  const base = file.replace(/^.*\//, "");
  if (/quickjs-[a-z]+\.o$|quickjs\.o$|libquickjs/.test(base)) return "quickjs";
  if (/^(main|protocol|vtime|arena|marks(_\w+)?|record|tape_host|pocket_runtime|pocket_input|rust_eh_personality)\.o$/.test(base)) {
    return "shell";
  }
  if (/libc\.a|libm\.a|crt1\.o|crti\.o|crtn\.o|crtbegin|crtend|libgcc|musl|rcrt1|Scrt1/.test(base)) return "libc";
  if (/libpocket_bench\.a|pocket_bench|pocketjs_core|pocketjs_symbian|taffy|compiler_builtins|\bcore-[0-9a-f]|\balloc-[0-9a-f]|rustc/.test(base)) {
    return "core";
  }
  return "other";
}

export function classifySymbol(name: string, fallback: Segment): Segment {
  if (/raster/i.test(name)) return "raster";
  return fallback;
}

interface MapParse {
  sections: Range[];
  symbols: { address: bigint; name: string }[];
}

export function parseLinkMap(text: string): MapParse {
  const sections: Range[] = [];
  const symbols: { address: bigint; name: string }[] = [];
  let pendingSection: string | null = null;
  let inMemoryMap = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^Linker script and memory map/.test(line)) inMemoryMap = true;
    if (!inMemoryMap) continue;

    // `.text.foo   0x0000000000010000   0x40 objects/main.o` — or the same split over two lines
    let m = /^\s*(\.[\w.$-]+)\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S.*)$/.exec(line);
    if (m) {
      pendingSection = null;
      pushSection(sections, m[1], m[2], m[3], m[4]);
      continue;
    }
    m = /^\s*(\.[\w.$-]+)\s*$/.exec(line);
    if (m) {
      pendingSection = m[1];
      continue;
    }
    if (pendingSection !== null) {
      m = /^\s+0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)\s+(\S.*)$/.exec(line);
      if (m) {
        pushSection(sections, pendingSection, m[1], m[2], m[3]);
        pendingSection = null;
        continue;
      }
      pendingSection = null;
    }
    // `                0x0000000000012340                pocketjs_core::raster::render_scaled`
    m = /^\s+0x([0-9a-fA-F]+)\s+([^\s0x][^\s]*)$/.exec(line);
    if (m && !/^0x/.test(m[2])) symbols.push({ address: BigInt(`0x${m[1]}`), name: m[2] });
  }
  symbols.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { sections, symbols };
}

function pushSection(out: Range[], section: string, startHex: string, sizeHex: string, file: string): void {
  if (!/^\.text(\.|$)/.test(section)) return;
  const start = BigInt(`0x${startHex}`);
  const size = BigInt(`0x${sizeHex}`);
  if (size === 0n) return;
  out.push({ start, end: start + size, segment: classifyObject(file.trim()) });
}

export function buildSegmap(parsed: MapParse): Range[] {
  const ranges: Range[] = [];
  for (const section of parsed.sections) {
    if (section.segment !== "core") {
      ranges.push(section);
      continue;
    }
    // Split the LTO'd Rust object by symbol boundaries so raster gets its own ranges.
    const inside = parsed.symbols.filter((s) => s.address >= section.start && s.address < section.end);
    if (inside.length === 0) {
      ranges.push(section);
      continue;
    }
    let cursor = section.start;
    let segment: Segment = "core";
    for (let i = 0; i < inside.length; i++) {
      const sym = inside[i];
      if (sym.address > cursor) ranges.push({ start: cursor, end: sym.address, segment });
      segment = classifySymbol(sym.name, "core");
      cursor = sym.address;
    }
    if (cursor < section.end) ranges.push({ start: cursor, end: section.end, segment });
  }
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && last.segment === r.segment && last.end >= r.start) {
      if (r.end > last.end) last.end = r.end;
    } else if (last && last.end > r.start) {
      // overlapping ranges of different segments: keep the earlier one, trim the later
      if (r.end > last.end) merged.push({ start: last.end, end: r.end, segment: r.segment });
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

export function renderSegmap(ranges: Range[], kernelBase: bigint | null): string {
  const lines = ranges.map((r) => `${r.start.toString(16)} ${r.end.toString(16)} ${r.segment}`);
  if (kernelBase !== null) lines.push(`kernel ${kernelBase.toString(16)}`);
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const mapPath = argv.find((a) => !a.startsWith("--"));
  const outIndex = argv.indexOf("--out");
  const kernelIndex = argv.indexOf("--kernel-base");
  if (!mapPath) {
    console.error("usage: bun plugin/segmap.ts <link.map> [--out segmap.txt] [--kernel-base 0x...]");
    process.exit(2);
  }
  const parsed = parseLinkMap(readFileSync(mapPath, "utf8"));
  const ranges = buildSegmap(parsed);
  const kernelBase = kernelIndex >= 0 ? BigInt(argv[kernelIndex + 1]) : null;
  const text = renderSegmap(ranges, kernelBase);
  if (outIndex >= 0) {
    writeFileSync(argv[outIndex + 1], text);
    const summary = new Map<string, number>();
    for (const r of ranges) summary.set(r.segment, (summary.get(r.segment) ?? 0) + Number(r.end - r.start));
    for (const [segment, bytes] of [...summary.entries()].sort()) console.log(`${segment.padEnd(8)} ${bytes} bytes`);
    console.log(`segmap: ${ranges.length} ranges -> ${argv[outIndex + 1]}`);
  } else {
    process.stdout.write(text);
  }
}
