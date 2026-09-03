// harness/compare.ts — 两个 results/host 目录逐 bundle × action × iteration 对比（docs/PLAN.md §5.8）。
//
//   bun harness/compare.ts --baseline baselines/v0.10.1/host --current results/host [--json out.json] [--md out.md]
//
// 计数类指标（hostops_*、nodes_*、jobs_count、drawlist_words、settle_frames、insns_* 等）exact=true：
//   delta 非零即 flagged。
// cpu_us 类指标按段汇总（同 action 各帧之和）：ratio-of-medians；同一目录里多次运行的文件名带
//   `.run<k>`（<bundle>.<observer>.run3.json），两边都 ≥ 5 次时给 bootstrap 95% CI；
//   偏离 > 5% 且（无 CI，或 CI 不含 1.0）才 flagged。

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MetricDelta } from "../spec/results.ts";
import { TIMED_STAGES } from "../spec/results.ts";
import type { HostBenchResult, HostRunFile } from "./run-host.ts";
import { listFiles, parseArgs, wantsHelp, writeJson } from "./lib.ts";

const LABEL = "bench compare";

export const EXACT_METRICS = [
  "hostops_total",
  "hostops_bytes",
  "boundary_calls",
  "nodes_created",
  "nodes_destroyed",
  "nodes_moved",
  "redundant_prop_writes",
  "jobs_count",
  "drawlist_words",
  "settle_frames",
  "bundle_bytes",
  "pak_bytes",
  "insns_total",
  "loads_total",
  "stores_total",
  "load_bytes_total",
  "store_bytes_total",
  "unique_code_lines",
  "unique_data_lines",
  "stack_high_water_bytes",
] as const;

export const CPU_THRESHOLD = 0.05;
export const CI_MIN_RUNS = 5;
export const BOOTSTRAP_ROUNDS = 2000;

export interface DeltaRow extends MetricDelta {
  bundle: string;
  action: string;
  iteration: string;
  /** 两边各有几次运行。 */
  runs: [number, number];
}

function usage(): never {
  console.error("usage: bun harness/compare.ts --baseline <dir> --current <dir> [--json out.json] [--md out.md]");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** `<bundle>.<observer>[.run<k>].json` → 分组键与 run 序号。 */
export function splitRunName(file: string): { key: string; run: number } {
  const name = basename(file).replace(/\.json$/, "");
  const match = name.match(/^(.*)\.run(\d+)$/);
  return match ? { key: match[1], run: Number(match[2]) } : { key: name, run: 0 };
}

export interface ResultSeries {
  bundle: string;
  action: string;
  iteration: string;
  /** 每次运行一个 result。 */
  runs: HostBenchResult[];
}

export function loadSeries(dir: string): Map<string, ResultSeries> {
  const series = new Map<string, ResultSeries>();
  for (const file of listFiles(dir, ".json")) {
    if (file === "index.json") continue;
    const path = join(dir, file);
    let parsed: HostRunFile;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as HostRunFile;
    } catch (error) {
      throw new Error(`${LABEL}: ${path}: ${(error as Error).message}`);
    }
    if (!Array.isArray(parsed.results)) continue;
    const { key } = splitRunName(file);
    for (const result of parsed.results) {
      const id = `${key}\u0000${result.action}\u0000${result.iteration}`;
      const entry = series.get(id) ?? { bundle: key, action: result.action, iteration: result.iteration, runs: [] };
      entry.runs.push(result);
      series.set(id, entry);
    }
  }
  return series;
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 确定性 PRNG（mulberry32），bootstrap 结果可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapRatioCI(baseline: readonly number[], current: readonly number[], rounds = BOOTSTRAP_ROUNDS, seed = 1): [number, number] {
  const random = mulberry32(seed);
  const resample = (values: readonly number[]): number[] => {
    const out = new Array<number>(values.length);
    for (let i = 0; i < values.length; i++) out[i] = values[Math.floor(random() * values.length)];
    return out;
  };
  const ratios: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const b = median(resample(baseline));
    const c = median(resample(current));
    ratios.push(b === 0 ? Number.NaN : c / b);
  }
  const sorted = ratios.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
  return [at(0.025), at(0.975)];
}

function cpuByStage(result: HostBenchResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const stage of TIMED_STAGES) out[`cpu_${stage}_us`] = 0;
  for (const phase of result.phases) {
    if (phase.cpu_us === undefined) continue;
    out[`cpu_${phase.stage}_us`] = (out[`cpu_${phase.stage}_us`] ?? 0) + phase.cpu_us;
  }
  out.action_cpu_us = result.metrics.action_cpu_us ?? 0;
  return out;
}

export function compareSeries(baseline: ResultSeries, current: ResultSeries): DeltaRow[] {
  const rows: DeltaRow[] = [];
  const runs: [number, number] = [baseline.runs.length, current.runs.length];
  const meta = { bundle: baseline.bundle, action: baseline.action, iteration: baseline.iteration, runs };

  for (const metric of EXACT_METRICS) {
    const b = baseline.runs[0].metrics[metric];
    const c = current.runs[0].metrics[metric];
    if (typeof b !== "number" || typeof c !== "number") continue;
    for (const [side, list] of [["baseline", baseline.runs], ["current", current.runs]] as const) {
      const distinct = new Set(list.map((r) => r.metrics[metric]));
      if (distinct.size > 1) console.warn(`${LABEL}: ${meta.bundle} ${meta.action}/${meta.iteration} ${metric} differs across ${side} runs: ${[...distinct].join(", ")}`);
    }
    rows.push({ ...meta, metric, baseline: b, current: c, delta: c - b, ratio: b === 0 ? null : c / b, exact: true, flagged: c !== b });
  }

  const baseCpu = baseline.runs.map(cpuByStage);
  const curCpu = current.runs.map(cpuByStage);
  for (const metric of Object.keys(baseCpu[0])) {
    const b = baseCpu.map((x) => x[metric] ?? 0);
    const c = curCpu.map((x) => x[metric] ?? 0);
    const bm = median(b);
    const cm = median(c);
    const ratio = bm === 0 ? null : cm / bm;
    const ci95 = b.length >= CI_MIN_RUNS && c.length >= CI_MIN_RUNS ? bootstrapRatioCI(b, c) : undefined;
    const deviates = ratio !== null && Math.abs(ratio - 1) > CPU_THRESHOLD;
    const ciExcludesOne = ci95 === undefined || !(ci95[0] <= 1 && 1 <= ci95[1]);
    rows.push({ ...meta, metric, baseline: bm, current: cm, delta: cm - bm, ratio, exact: false, ...(ci95 ? { ci95 } : {}), flagged: deviates && ciExcludesOne });
  }
  return rows;
}

export function compareDirs(baselineDir: string, currentDir: string): { rows: DeltaRow[]; missing: string[]; added: string[] } {
  const baseline = loadSeries(baselineDir);
  const current = loadSeries(currentDir);
  const rows: DeltaRow[] = [];
  const missing: string[] = [];
  const added: string[] = [];
  for (const [id, series] of baseline) {
    const other = current.get(id);
    if (!other) {
      missing.push(`${series.bundle} ${series.action}/${series.iteration}`);
      continue;
    }
    rows.push(...compareSeries(series, other));
  }
  for (const [id, series] of current) if (!baseline.has(id)) added.push(`${series.bundle} ${series.action}/${series.iteration}`);
  return { rows, missing, added };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

function fmt(value: number, exact: boolean): string {
  if (!Number.isFinite(value)) return "—";
  return exact ? String(value) : value.toFixed(0);
}

export function renderMarkdown(rows: DeltaRow[], missing: string[], added: string[]): string {
  const lines: string[] = ["# bench compare", ""];
  const flagged = rows.filter((r) => r.flagged);
  lines.push(`${rows.length} metric(s) compared, **${flagged.length} flagged**.`, "");
  if (missing.length > 0) lines.push(`Missing in current: ${missing.join(", ")}`, "");
  if (added.length > 0) lines.push(`New in current: ${added.join(", ")}`, "");
  const groups = new Map<string, DeltaRow[]>();
  for (const row of rows) {
    const key = `${row.bundle} · ${row.action}/${row.iteration}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, group] of groups) {
    const shown = group.filter((r) => r.flagged || r.exact);
    if (shown.length === 0) continue;
    lines.push(`## ${key}`, "", "| metric | baseline | current | Δ | ratio | 95% CI | |", "|---|---:|---:|---:|---:|---|---|");
    for (const row of shown) {
      lines.push(
        `| \`${row.metric}\` | ${fmt(row.baseline, row.exact)} | ${fmt(row.current, row.exact)} | ${fmt(row.delta, row.exact)} | ${row.ratio === null ? "—" : row.ratio.toFixed(3)} | ${row.ci95 ? `[${row.ci95[0].toFixed(3)}, ${row.ci95[1].toFixed(3)}]` : "—"} | ${row.flagged ? "**flag**" : ""} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) usage();
  const baselineDir = args.flags.get("baseline");
  const currentDir = args.flags.get("current");
  if (!baselineDir || !currentDir) usage();
  const { rows, missing, added } = compareDirs(baselineDir, currentDir);
  const report = { generated: new Date().toISOString(), baseline: baselineDir, current: currentDir, missing, added, deltas: rows };
  const jsonOut = args.flags.get("json");
  const mdOut = args.flags.get("md");
  if (jsonOut) writeJson(jsonOut, report);
  const markdown = renderMarkdown(rows, missing, added);
  if (mdOut) await Bun.write(mdOut, `${markdown}\n`);
  if (!jsonOut && !mdOut) console.log(markdown);
  else console.log(`${LABEL}: ${rows.length} metric(s), ${rows.filter((r) => r.flagged).length} flagged${jsonOut ? ` -> ${jsonOut}` : ""}${mdOut ? ` -> ${mdOut}` : ""}`);
  if (rows.some((r) => r.flagged && r.exact)) process.exitCode = 1;
}

if (import.meta.main) await main();
