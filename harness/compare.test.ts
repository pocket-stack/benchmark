import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapRatioCI, compareDirs, compareSeries, median, splitRunName, type ResultSeries } from "./compare.ts";
import { hostResult as result, hostRun, IDENTITY } from "./fixtures/results.ts";
import type { HostBenchResult } from "./run-host.ts";

function series(runs: HostBenchResult[]): ResultSeries {
  return { bundle: "list-create.solid.measure", action: runs[0].action, iteration: "first", runs };
}

describe("compare", () => {
  test("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("run file names split into key and run index", () => {
    expect(splitRunName("hero.solid.measure.json")).toEqual({ key: "hero.solid.measure", run: 0 });
    expect(splitRunName("hero.solid.measure.run7.json")).toEqual({ key: "hero.solid.measure", run: 7 });
  });

  test("exact metrics flag on any non-zero delta", () => {
    const rows = compareSeries(series([result("create", 1000, 3000)]), series([result("create", 1000, 3001)]));
    const hostops = rows.find((r) => r.metric === "hostops_total")!;
    expect(hostops.exact).toBe(true);
    expect(hostops.delta).toBe(1);
    expect(hostops.flagged).toBe(true);
    const nodes = rows.find((r) => r.metric === "nodes_created")!;
    expect(nodes.flagged).toBe(false);
  });

  test("cpu metrics flag beyond 5% (single run, no CI)", () => {
    const slow = compareSeries(series([result("create", 1000, 3000)]), series([result("create", 1100, 3000)]));
    const cpu = slow.find((r) => r.metric === "action_cpu_us")!;
    expect(cpu.exact).toBe(false);
    expect(cpu.ratio).toBeCloseTo(1.1, 5);
    expect(cpu.ci95).toBeUndefined();
    expect(cpu.flagged).toBe(true);
    const js = slow.find((r) => r.metric === "cpu_js_us")!;
    expect(js.flagged).toBe(true);
    const near = compareSeries(series([result("create", 1000, 3000)]), series([result("create", 1020, 3000)]));
    expect(near.find((r) => r.metric === "action_cpu_us")!.flagged).toBe(false);
  });

  test("≥5 runs on both sides get a bootstrap CI that gates the flag", () => {
    const base = series([1000, 1010, 990, 1005, 995].map((c) => result("create", c, 3000)));
    const noisy = series([1200, 900, 1150, 950, 1080].map((c) => result("create", c, 3000)));
    const rows = compareSeries(base, noisy);
    const cpu = rows.find((r) => r.metric === "action_cpu_us")!;
    expect(cpu.ci95).toBeDefined();
    expect(cpu.ci95![0]).toBeLessThanOrEqual(1);
    expect(cpu.ci95![1]).toBeGreaterThanOrEqual(1);
    expect(cpu.flagged).toBe(false);
    const shifted = series([1200, 1210, 1190, 1205, 1195].map((c) => result("create", c, 3000)));
    const sure = compareSeries(base, shifted).find((r) => r.metric === "action_cpu_us")!;
    expect(sure.ci95![0]).toBeGreaterThan(1);
    expect(sure.flagged).toBe(true);
  });

  test("bootstrap is deterministic", () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [2, 3, 4, 5, 6, 7];
    expect(bootstrapRatioCI(a, b)).toEqual(bootstrapRatioCI(a, b));
  });

  test("compareDirs groups .run<k> files and reports missing / added", () => {
    const base = mkdtempSync(join(tmpdir(), "bench-base-"));
    const cur = mkdtempSync(join(tmpdir(), "bench-cur-"));
    const file = (results: HostBenchResult[]) => hostRun(results);
    writeFileSync(join(base, "list-create.solid.measure.run1.json"), JSON.stringify(file([result("create", 1000, 3000)])));
    writeFileSync(join(base, "list-create.solid.measure.run2.json"), JSON.stringify(file([result("create", 1002, 3000)])));
    writeFileSync(join(base, "hero.solid.measure.json"), JSON.stringify(file([result("tape", 500, 10)])));
    writeFileSync(join(cur, "list-create.solid.measure.json"), JSON.stringify(file([result("create", 1001, 3000), result("clear", 100, 1000)])));
    const { rows, missing, added } = compareDirs(base, cur);
    const cpu = rows.find((r) => r.metric === "action_cpu_us" && r.action === "create")!;
    expect(cpu.runs).toEqual([2, 1]);
    expect(cpu.baseline).toBe(1001);
    expect(missing).toEqual(["hero.solid.measure tape/first"]);
    expect(added).toEqual(["list-create.solid.measure clear/first"]);
  });
});
