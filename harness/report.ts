// harness/report.ts — 把一个 results 目录（host/ 与 oracle/）汇总成 Markdown，供 PR 评论。
//
//   bun harness/report.ts [--results results] [--md out.md]
//
// 每个 bundle × action × iteration 一行：settle_frames、六段 cpu_us、hostops_total、
// nodes_created、oracle_match；oracle 有而 host 没有的 bundle 单独列出。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TIMED_STAGES } from "../spec/results.ts";
import { loadSeries, median, splitRunName, type ResultSeries } from "./compare.ts";
import type { OracleFile } from "./oracle.ts";
import type { HostFailure } from "./run-host.ts";
import { RESULTS, listFiles, parseArgs, wantsHelp } from "./lib.ts";

function usage(): never {
  console.error("usage: bun harness/report.ts [--results <dir>] [--md out.md]");
  process.exit(2);
}

function stageMedian(series: ResultSeries, stage: string): number {
  return median(
    series.runs.map((r) => r.phases.filter((p) => p.stage === stage).reduce((sum, p) => sum + (p.cpu_us ?? 0), 0)),
  );
}

export function renderReport(resultsDir: string): string {
  const hostDir = join(resultsDir, "host");
  const oracleDir = join(resultsDir, "oracle");
  // 按 bundle 排序，bundle 内保持 JSONL 里的执行顺序（mount → 各 action → steady）。
  const series = [...loadSeries(hostDir).values()].sort((a, b) => a.bundle.localeCompare(b.bundle));
  const lines: string[] = ["# bench report", ""];
  if (series.length === 0) lines.push(`No host results in ${hostDir}.`, "");
  else {
    const runCounts = new Set(series.map((s) => s.runs.length));
    lines.push(`${series.length} row(s); runs per row: ${[...runCounts].join(", ")} (cpu columns are medians, µs).`, "");
    lines.push(
      `| bundle | action | iter | settle | ${TIMED_STAGES.join(" | ")} | action cpu | hostops | nodes+ | oracle |`,
      `|---|---|---|---:|${TIMED_STAGES.map(() => "---:").join("|")}|---:|---:|---:|---|`,
    );
    for (const s of series) {
      const first = s.runs[0];
      const cpu = TIMED_STAGES.map((stage) => stageMedian(s, stage).toFixed(0)).join(" | ");
      const match = s.runs.every((r) => r.oracle_match);
      lines.push(
        `| ${s.bundle} | ${s.action} | ${s.iteration} | ${first.metrics.settle_frames ?? "—"} | ${cpu} | ${median(s.runs.map((r) => r.metrics.action_cpu_us ?? 0)).toFixed(0)} | ${first.metrics.hostops_total ?? "—"} | ${first.metrics.nodes_created ?? "—"} | ${match ? "ok" : "**MISMATCH**"} |`,
      );
    }
    lines.push("");
  }

  const hostBundles = new Set(listFiles(hostDir, ".json").map((f) => splitRunName(f).key.replace(/\.(measure|observe)$/, "")));
  const oracleOnly: string[] = [];
  for (const file of listFiles(oracleDir, ".json")) {
    const oracle = JSON.parse(readFileSync(join(oracleDir, file), "utf8")) as OracleFile;
    if (!hostBundles.has(oracle.bundle)) oracleOnly.push(`${oracle.bundle} (${oracle.actions.length} action(s))`);
  }
  if (oracleOnly.length > 0) lines.push("Oracle only (no host run yet): " + oracleOnly.join(", "), "");

  const failures: HostFailure[] = [];
  for (const observer of ["measure", "observe"]) {
    const path = join(hostDir, `failures.${observer}.json`);
    if (!existsSync(path)) continue;
    const file = JSON.parse(readFileSync(path, "utf8")) as { failures?: HostFailure[] };
    failures.push(...(file.failures ?? []));
  }
  if (failures.length > 0) {
    lines.push("## Bundle failures", "", "| bundle | observer | exit | error |", "|---|---|---:|---|");
    for (const failure of failures) {
      const error = failure.stderr.split("\n")[0]?.replaceAll("|", "\\|") ?? "";
      lines.push(`| ${failure.bundle} | ${failure.observer} | ${failure.exit_code} | ${error} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) usage();
  const resultsDir = args.flags.get("results") ?? RESULTS;
  if (!existsSync(resultsDir)) throw new Error(`bench report: ${resultsDir} does not exist`);
  const markdown = renderReport(resultsDir);
  const mdOut = args.flags.get("md");
  if (mdOut) {
    await Bun.write(mdOut, `${markdown}\n`);
    console.log(`bench report: -> ${mdOut}`);
  } else console.log(markdown);
}

if (import.meta.main) await main();
