// harness/baseline.ts — 把当前 results/ 快照成一个命名 baseline，供 compare 用。
//
//   bun harness/baseline.ts save <name>       results/{host,oracle} → baselines/<name>/
//   bun harness/baseline.ts list
//   bun harness/compare.ts --baseline baselines/<name>/host --current results/host
//
// baseline 目录提交进仓库（docs/PLAN.md §5.8：tag 级 baseline 入库，per-commit
// 结果只做 CI artifact）。namespace 规则也在 §5.8：identity 里 QEMU / SO3 /
// 工具链 / QuickJS 任一项变化就换名字，不覆盖旧数据。

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS, ROOT, gitHead } from "./lib.ts";

const LABEL = "bench baseline";
const BASELINES = join(ROOT, "baselines");

function usage(): never {
  console.error("usage: bun harness/baseline.ts save <name> | list");
  process.exit(2);
}

function save(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(`${LABEL}: baseline names are [a-z0-9._-], got ${JSON.stringify(name)}`);
  }
  const target = join(BASELINES, name);
  if (existsSync(target)) {
    throw new Error(`${LABEL}: ${target} exists — baselines are append-only, pick a new name`);
  }
  let copied = 0;
  for (const kind of ["host", "oracle"]) {
    const source = join(RESULTS, kind);
    if (!existsSync(source)) continue;
    for (const file of readdirSync(source)) {
      if (!file.endsWith(".json")) continue;
      mkdirSync(join(target, kind), { recursive: true });
      cpSync(join(source, file), join(target, kind, file));
      copied += 1;
    }
  }
  if (copied === 0) throw new Error(`${LABEL}: nothing to snapshot — run oracle/run-host first`);
  writeFileSync(
    join(target, "baseline.json"),
    `${JSON.stringify(
      {
        name,
        saved: new Date().toISOString(),
        bench_commit: gitHead(ROOT),
        pocketjs_commit: gitHead(join(ROOT, "vendor/pocketjs")),
        files: copied,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${LABEL}: ${copied} file(s) -> ${target}`);
}

function list(): void {
  if (!existsSync(BASELINES)) return;
  for (const entry of readdirSync(BASELINES).sort()) {
    if (entry.startsWith(".")) continue;
    const meta = join(BASELINES, entry, "baseline.json");
    if (existsSync(meta)) {
      const parsed = require(meta) as { saved: string; files: number; pocketjs_commit: string | null };
      console.log(`${entry}  ${parsed.saved}  ${parsed.files} file(s)  pocketjs=${(parsed.pocketjs_commit ?? "?").slice(0, 7)}`);
    } else {
      console.log(entry);
    }
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) usage();
if (argv[0] === "save") {
  if (!argv[1]) usage();
  save(argv[1]);
} else if (argv[0] === "list") {
  list();
} else {
  usage();
}
