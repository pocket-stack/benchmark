# pocketjs-bench

PocketJS 的 benchmark 仓库。被测物是 `vendor/pocketjs`（git submodule，钉 commit）。三台 host 各管一件事：

- **sim / wasm oracle**（`harness/oracle.ts`，Bun + wasm）：语义权威，产出每个 action 的 DrawList hash 与 framebuffer hash；不计时。
- **CI host 上的 bench shell**（`shell/`，C）：设备同谱系的 QuickJS（`pocket-stack/quickjs-rs`）+ `pocketjs-core` + 软件光栅，按 `eval / js / jobs / tick / draw / render` 六段记线程 CPU 时间；同一 bundle 的 hash 与 oracle 并排记录。
- **QEMU + SO3 virt32 / virt64**（`ref/`、`plugin/`）：只算指令数，按 workload × PC 段 × 阶段 × 帧归属；两台参考机均已跑通全部 10 条 neutral tape。

没有墙钟：运行时内部一切按虚拟帧；`Date.now()` 由 shell 给虚拟时间。设计与里程碑见 `docs/PLAN.md`，case 协议见 `docs/PROTOCOL.md`，shell 命令行见 `docs/SHELL.md`。

## 快速开始

需要 Bun 1.3.14、CMake ≥ 3.24、Ninja，以及 rustup（crate 会自动选择钉住的 nightly）。

```sh
git submodule update --init                # vendor/pocketjs、vendor/quickjs-rs
(cd vendor/pocketjs && bun install)        # 框架依赖只能有一份，装在 submodule 里

cmake --preset host                       # 配置 Ninja：Rust staticlib + QuickJS + 三种 shell
cmake --build --preset host
bun harness/build.ts --apps hero           # 全部 case × 各自声明的框架 + hero → dist/bundles/
bun harness/oracle.ts                      # wasm oracle → results/oracle/
bun harness/run-host.ts --shell dist/shell/host/pocket-bench-shell
bun harness/run-host.ts --shell dist/shell/host/pocket-bench-shell-observe --observer observe
bun harness/report.ts                      # Markdown 表：settle、六段 cpu_us、hostops、oracle 是否相等
bun run test                               # spec / harness / corpus / plugin / cases 的测试
```

`vendor/pocketjs` 当前指向 HalfSweet/pocketjs 的公开 `feat/soft-host` 分支；其中包含
`hosts/soft/` 与 bench hook。相关改动合并上游后再把 submodule URL 切回 pocket-stack。

## 目录

```
spec/        tape.ts（MutationTape / DrawListTape 格式）、protocol.ts（case 协议、shell 输出）、results.ts、gen-c.ts / gen-rust.ts
cases/       canonical micro case（10 个场景：mount-static、deep-tree、reactive-single/-fanout/-fanin/-diamond、list-create、list-ops、animation、soak-churn）及 manifest 正式测试
harness/     build / oracle / run-host / run-ref / compare / report（Bun）
shell/       bench shell：main.c、arena、vtime、marks、record + generated/（由 spec 生成）
cmake/       SO3 ARM32/AArch64 toolchain；顶层 CMakeLists.txt 与 presets 是唯一 C 构建入口
crates/      pocket-bench：symbian-core 的 C ABI + replayer + DrawList words + RGBA8 光栅
corpus/      中立 MutationTape 生成器与已生成的 10 条 .pkmt
plugin/      QEMU TCG plugin（真 QEMU 冒烟通过，aarch64 + arm32；smoke/ 可一键重跑）
ref/         digest 锁定的单一 reference backend 与 QEMU/SO3 固化流程
baselines/   已归档且与当前 schema 兼容的 baseline（当前为 host）
docs/        PLAN、PROTOCOL、SHELL、FINDINGS
```

## 状态

| 部分 | 状态 |
|---|---|
| `full` 模式（guest + core + raster） | 10 个 case（29 个框架变体）+ hero × 3；两种 observer 均逐 action 记录与各自 oracle 的比较结果 |
| `native` 模式（MutationTape 回放） | hero 录制的 tape 回放后 DrawList / fb hash 与 full 相等，RET 校验 0 次不等；中立 corpus 10 条 tape 全部可回放 |
| `raster` 模式（DrawListTape） | `--tape` 重建资产 + 基底帧后逐字节复现 full 的最终帧；`--pak` 是近似路径 |
| `guest-tape` 模式 | `pocket-bench-shell-guest` 上锁步匹配整条录制（op 码、每个参数字、帧边界），任何分歧退出 5；输入 tape 与 bench 协议两种录制都支持（ACTION 记录重放 `run()`） |
| TCG plugin | 冒烟(EL1 裸机,aarch64 + arm32)与 SO3 全系统(EL0)均通过;marker 全命中、icount 下两跑非 idle 计数逐字节相同 |
| SO3 参考机 | virt32 / virt64 bench profile 均在 stock QEMU 10.0.11 上跑完 10 条 neutral tape × 2；hash 与 host 一致，run × 段 × 阶段 × 帧的非 idle 计数两跑相同 |
| compare / baselines / CI | compare.ts、baseline.ts 可用；host、非门禁 reference，以及验证后自动提升 digest 的 backend publisher 均已接入 |

benchmark 已经抓到的真问题（详见 `docs/FINDINGS.md`）：Solid renderer 自锚插入在纯反转时抛错且在设备后端静默乱序（已修）；**Vue Vapor 在 QuickJS 上 churn 每帧滞留 ≈6 MB**（600 帧 3.64 GB，设备必 OOM，JSC 上无感）；`gallery.octane` 的挂载栈峰值超过设备 256 KB 上限；virt32 原 64 KB 用户栈跑 `deep-32` 越界；以及一组跨框架语义差异记录。
