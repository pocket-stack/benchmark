# harness

Bun 脚本，从仓库根运行；每个都有 `--help`。没有 npm 依赖。

| 脚本 | 做什么 | 产物 |
|---|---|---|
| `build.ts` | 把 `cases/` 与主仓三变体 app 编成 bundle（case 先复制到 `vendor/pocketjs/.pocket-build/bench-cases/`，让 `solid-js` 等只解析到 submodule 的一份） | `dist/bundles/<name>.<fw>.{js,pak}`、`dist/bundles/index.json` |
| `oracle.ts` | 在 wasm oracle 上按 case 协议 / 输入 tape 跑每个 bundle，记 settle 帧的 DrawList hash（`ui_draw_hash`，FNV-1a 64）与 fb hash（FNV-1a 32 over RGBA8）以及 op 计数 | `results/oracle/<bundle>.json` |
| `run-host.ts` | 起 bench shell（`docs/SHELL.md`），把 JSONL 折成 `BenchResult` 并与 oracle 对照；单个 bundle 失败时记录后继续 | `results/host/<bundle>.<observer>.json`、`failures.<observer>.json`、`jsonl/` |
| `run-ref.ts` | 在 digest 锁定的 reference backend 里运行准备好的 SO3 corpus 两次，校验 serial、run_id、hash、RET 与逐 run 非 idle 计数的确定性 | `results/ref/<profile>/{serial,counts}-N.*`、`summary.json` |
| `compare.ts` | 两个结果目录逐 bundle × action × iteration 对比：计数类精确 delta，cpu 类 ratio-of-medians + bootstrap CI | JSON / Markdown |
| `report.ts` | 一个结果目录的 Markdown 汇总（PR 评论用） | Markdown |
| `apps.json` | 宏 app 的默认输入 tape（来自主仓 `tools/bench-ppsspp.ts` 的 SPECS） | — |

```sh
bun harness/build.ts --apps hero --cases none
bun harness/oracle.ts
bun harness/run-host.ts --shell dist/shell/host/pocket-bench-shell --observer observe
ref/build-tools.sh --profile virt64
ref/prepare-reference.sh --profile virt64
bun harness/run-ref.ts --profile virt64-bench --artifacts dist/ref-artifacts/virt64 --segmap dist/shell/so3-aarch64/segmap.txt
bun harness/report.ts
bun harness/compare.ts --baseline baselines/<tag>/host --current results/host --md compare.md
bun test harness/
```

settle 规则只在 `lib.ts` 实现一次（`settleStep`）；bench shell 必须与它逐字一致：`frames` 与 `stable` 每个 action 归零，`last`（上一帧 fb hash）跨 action 延续。`run-host.ts --from-jsonl` 可以在没有 shell 时折叠一份 JSONL（样例在 `fixtures/`）。

多次运行：同一目录里文件名带 `.run<k>`（`hero.solid.measure.run3.json`），`compare.ts` 会按 key 分组；两边各 ≥ 5 次才给 CI。
