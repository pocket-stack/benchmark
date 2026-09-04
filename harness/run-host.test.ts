import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS } from "./lib.ts";
import { BUNDLE, IDENTITY } from "./fixtures/results.ts";
import type { OracleFile } from "./oracle.ts";
import { foldRecords, parseJsonl, runBundles, shellArgs } from "./run-host.ts";

const FIXTURES = join(HARNESS, "fixtures");

function load() {
  const jsonl = join(FIXTURES, "host-shell.sample.jsonl");
  const records = parseJsonl(readFileSync(jsonl, "utf8"), jsonl);
  const oracle = JSON.parse(readFileSync(join(FIXTURES, "oracle.sample.json"), "utf8")) as OracleFile;
  return { records, oracle, jsonl };
}

describe("run-host fold", () => {
  test("one result per action × iteration, warmup skipped", () => {
    const { records, oracle, jsonl } = load();
    const folded = foldRecords(records, { bundle: BUNDLE, observer: "observe", oracle, shell: null, jsonl, identity: IDENTITY });
    expect(folded.results.map((r) => `${r.action}/${r.iteration}`)).toEqual(["mount/first", "create/first", "clear/first"]);
    expect(folded.results.every((r) => r.case === "list-create@1000")).toBe(true);
    expect(folded.results.every((r) => r.family === "list" && r.track === "canonical")).toBe(true);
  });

  test("stage sums and mount metrics", () => {
    const { records, oracle, jsonl } = load();
    const folded = foldRecords(records, { bundle: BUNDLE, observer: "observe", oracle, shell: null, jsonl, identity: IDENTITY });
    const mount = folded.results[0];
    expect(mount.metrics.eval_us).toBe(120000);
    expect(mount.metrics.mount_to_settle_us).toBe(900 + 10 + 50 + 300 + 800 + 700 + 5 + 50 + 200 + 800);
    expect(mount.metrics.action_cpu_us).toBe(mount.metrics.mount_to_settle_us);
    const create = folded.results[1];
    expect(create.metrics.action_cpu_us).toBe(4800 + 20 + 60 + 900 + 850 + 100 + 5 + 55 + 400 + 850);
    expect(create.metrics.jobs_us).toBe(25);
    expect(create.metrics.jobs_count).toBe(1);
    expect(create.metrics.settle_frames).toBe(2);
    expect(create.metrics.hostops_total).toBe(3000);
    expect(create.metrics.nodes_created).toBe(1000);
    expect(create.metrics.bundle_bytes).toBe(1234);
    expect(create.metrics.eval_us).toBeUndefined();
    expect(create.phases.length).toBe(10);
  });

  test("oracle_match compares drawlist and framebuffer hashes per action", () => {
    const { records, oracle, jsonl } = load();
    const ok = foldRecords(records, { bundle: BUNDLE, observer: "observe", oracle, shell: null, jsonl, identity: IDENTITY });
    expect(ok.results.every((r) => r.oracle_match)).toBe(true);
    const tampered = structuredClone(oracle);
    tampered.actions[0].hashes.fb_rgba8 = "ffffffff";
    const bad = foldRecords(records, { bundle: BUNDLE, observer: "observe", oracle: tampered, shell: null, jsonl, identity: IDENTITY });
    expect(bad.results.map((r) => r.oracle_match)).toEqual([true, false, true]);
    const none = foldRecords(records, { bundle: BUNDLE, observer: "observe", oracle: null, shell: null, jsonl, identity: IDENTITY });
    expect(none.results.every((r) => !r.oracle_match)).toBe(true);
  });

  test("rejects a JSONL without an end record", () => {
    const { records, oracle, jsonl } = load();
    const truncated = records.filter((r) => r.kind !== "end");
    expect(() => foldRecords(truncated, { bundle: BUNDLE, observer: "observe", oracle, shell: null, jsonl, identity: IDENTITY })).toThrow(/end record/);
  });

  test("parseJsonl names the bad line", () => {
    expect(() => parseJsonl('{"kind":"identity"}\nnot json\n', "x.jsonl")).toThrow(/x\.jsonl:2/);
    expect(() => parseJsonl('{"kind":"bogus"}\n', "x.jsonl")).toThrow(/unknown record kind/);
  });

  test("shell arguments follow docs/SHELL.md", () => {
    const caseArgs = shellArgs(BUNDLE, "measure", "/tmp/out.jsonl");
    expect(caseArgs).toEqual([
      "--mode", "full", "--observer", "measure", "--js", "/dev/null", "--pak", "/dev/null", "--hz", "60", "--out", "/tmp/out.jsonl",
      "--bench", "--actions", "create,clear", "--warmup", "1", "--max-settle", "120",
    ]);
    const appArgs = shellArgs({ ...BUNDLE, kind: "app", case: null, tape: { frames: 96, input: "0:0,58:0x40" } }, "observe", "/tmp/o.jsonl");
    expect(appArgs.slice(-4)).toEqual(["--frames", "96", "--input", "0:0,58:0x40"]);
    const noInput = shellArgs({ ...BUNDLE, kind: "app", case: null, tape: { frames: 90, input: "" } }, "observe", "/tmp/o.jsonl");
    expect(noInput.includes("--input")).toBe(false);
  });

  test("a failed bundle is recorded and does not stop later bundles", () => {
    const outDir = mkdtempSync(join(tmpdir(), "bench-run-host-"));
    const failed = { ...BUNDLE, bundle: "broken.solid", name: "broken", js: "/broken.js" };
    const fixture = readFileSync(join(FIXTURES, "host-shell.sample.jsonl"), "utf8");
    const attempted: string[] = [];
    const summary = runBundles("/fake-shell", [failed, BUNDLE], "observe", outDir, {
      execute(_command, args) {
        const js = args[args.indexOf("--js") + 1];
        attempted.push(js);
        if (js === failed.js) return { exitCode: 2, stdout: "", stderr: "stack overflow" };
        const jsonl = args[args.indexOf("--out") + 1];
        writeFileSync(jsonl, fixture);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      oracleFor: () => null,
      identity: IDENTITY,
      log: () => {},
      warn: () => {},
    });

    expect(attempted).toEqual([failed.js, BUNDLE.js]);
    expect(summary.completed).toBe(1);
    expect(summary.failures).toEqual([
      {
        bundle: failed.bundle,
        observer: "observe",
        exit_code: 2,
        stderr: "stack overflow",
        jsonl: join(outDir, "jsonl", "broken.solid.observe.jsonl"),
      },
    ]);
    expect(JSON.parse(readFileSync(summary.failurePath, "utf8")).failures).toEqual(summary.failures);
    expect(JSON.parse(readFileSync(join(outDir, "list-create.solid.observe.json"), "utf8")).results).toHaveLength(3);
  });
});
