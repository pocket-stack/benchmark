import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSerial, stableCounts, validateOne, type CorpusManifest, type CountsFile } from "./run-ref.ts";
import { ROOT } from "./lib.ts";

describe("run-ref", () => {
  test("parses completed logical runs out of noisy SO3 serial", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ref-"));
    const path = join(dir, "serial.txt");
    writeFileSync(
      path,
      [
        "SO3 boot banner",
        '{"kind":"identity","host":"so3-virt32","run_id":4}',
        '{"kind":"phase","action":"tape"}',
        '{"kind":"action","action":"tape","iteration":"first","settled":true,"settle_frames":3,"hashes":{"drawlist":"aa","fb_rgba8":"bb"},"metrics":{"replay_mismatches":0}}',
        '{"kind":"end","exit":0}',
        "/ % ",
      ].join("\n"),
    );
    expect(parseSerial(path)).toEqual([
      { run_id: 4, host: "so3-virt32", frames: 3, drawlist: "aa", fb_rgba8: "bb", replay_mismatches: 0 },
    ]);
  });

  test("rejects a logical run without an end record", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ref-"));
    const path = join(dir, "serial.txt");
    writeFileSync(path, '{"kind":"identity","host":"so3-virt64","run_id":1}\n');
    expect(() => parseSerial(path)).toThrow(/did not finish/);
  });

  test("validates marker integrity, plugin version and complete run ownership", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-ref-"));
    const serialPath = join(dir, "serial.txt");
    const countsPath = join(dir, "counts.json");
    const manifest: CorpusManifest = {
      schema_version: 1,
      profile: "so3-virt32-bench",
      shell_sha256: "shell",
      corpus_index_sha256: "corpus",
      artifacts: {},
      runs: [{ run_id: 7, file: "wide-10.pkmt", family: "wide", scale: 10, frames: 3, tape_fnv1a64: "hash" }],
    };
    writeFileSync(
      serialPath,
      [
        '{"kind":"identity","host":"so3-virt32","run_id":7}',
        '{"kind":"action","action":"tape","iteration":"first","settled":true,"settle_frames":3,"hashes":{"drawlist":"aa","fb_rgba8":"bb"},"metrics":{"replay_mismatches":0}}',
        '{"kind":"end","exit":0}',
      ].join("\n"),
    );
    const cell = { insns: 1, loads: 0, stores: 0, load_bytes: 0, store_bytes: 0 };
    const counts: CountsFile = {
      plugin: "pocketcount",
      version: 2,
      arch: "arm",
      marker_hits: 3,
      marker_misses: 0,
      by_run: [{ run_id: 7, by_segment_stage: { core: { draw: cell } }, by_frame: [] }],
    };
    writeFileSync(countsPath, JSON.stringify(counts));
    expect(validateOne(manifest, serialPath, countsPath).observations).toHaveLength(1);

    writeFileSync(countsPath, JSON.stringify({ ...counts, marker_misses: 1 }));
    expect(() => validateOne(manifest, serialPath, countsPath)).toThrow(/marker miss/);

    writeFileSync(countsPath, JSON.stringify({ ...counts, by_run: [] }));
    expect(() => validateOne(manifest, serialPath, countsPath)).toThrow(/by_run ids/);

    writeFileSync(countsPath, JSON.stringify({ ...counts, version: 1 }));
    expect(() => validateOne(manifest, serialPath, countsPath)).toThrow(/need pocketcount v2/);
  });

  test("determinism projection drops idle but preserves by-run counts", () => {
    const cell = (insns: number) => ({ insns, loads: 0, stores: 0, load_bytes: 0, store_bytes: 0 });
    const counts: CountsFile = {
      plugin: "pocketcount",
      version: 2,
      arch: "arm",
      marker_hits: 3,
      marker_misses: 0,
      by_run: [
        {
          run_id: 2,
          by_segment_stage: { core: { idle: cell(999), draw: cell(12) } },
          by_frame: [{ frame: 0, by_segment_stage: { core: { idle: cell(5), draw: cell(12) } } }],
        },
      ],
    };
    expect(stableCounts(counts)).toEqual({
      arch: "arm",
      marker_hits: 3,
      marker_misses: 0,
      by_run: [
        {
          run_id: 2,
          by_segment_stage: { core: { draw: cell(12) } },
          by_frame: [{ frame: 0, by_segment_stage: { core: { draw: cell(12) } } }],
        },
      ],
    });
  });

  test("both SO3 bench profiles pin one CPU, no timed devices and a 256 KB user stack", () => {
    for (const profile of ["virt32", "virt64"]) {
      const config = readFileSync(join(ROOT, "ref/so3", `${profile}_bench_defconfig`), "utf8");
      expect(config).toContain("CONFIG_NR_CPUS=1");
      expect(config).toContain("# CONFIG_NET is not set");
      expect(config).toContain("# CONFIG_FB is not set");
      expect(config).toContain("# CONFIG_SMC911X is not set");
      expect(config).toContain("CONFIG_THREAD_STACK_SIZE_KB=256");
    }
  });
});
