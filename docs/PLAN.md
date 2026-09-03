# PocketJS benchmark：架构与路线

本仓库观察一个钉住的 PocketJS commit 在不同执行层上的行为和成本。它提供稳定输入、
细粒度结果和可重复的参考机计数，但不替开发者判断某个框架实现是否“更好”。

## 1. 目标与非目标

目标：

- 用通用 workload 描述 mount、reactive、list、animation 和 soak 场景；
- 允许 Solid、Vue Vapor、Octane 分别采用适合自己的实现；
- 同时观察 framework/QuickJS、native core 和软件光栅的成本；
- 保存足够的 identity、阶段、帧、HostOps、hash、内存和参考机计数；
- 让单个失败 workload 保持可见，不阻断其余 workload 的采集。

非目标：

- 不要求不同框架形成相同 native tree、DrawList、HostOps 或 framebuffer；
- 不把不同层的数字相加成总分；
- 当前 CI 用于暴露差异与缺陷，不作为强制性能门禁；
- 不把 QEMU 指令数解释成真实设备墙钟时间。

## 2. 三层执行

| 层 | 入口 | 输入 | 主要输出 |
|---|---|---|---|
| wasm oracle | harness/oracle.ts | bundle + case/input script | 每个 action 的 DrawList/RGBA8 hash 与 HostOps |
| host shell | harness/run-host.ts | 同一个 bundle | 六阶段线程 CPU 时间、arena、HostOps、hash |
| SO3 reference | harness/run-ref.ts | neutral MutationTape | run × segment × stage × frame 的指令与访存 |

oracle 只对“同一个 bundle 在两种 host 上是否重现自身语义”提供依据。它不横向比较
不同框架。SO3 reference 使用 neutral tape，不运行 JS 框架。

## 3. Workload 契约

### Canonical case

cases 下每个目录包含：

- case.json：id、family、scale、参与框架、action 顺序、warmup 与 settle 上限；
- 每个参与框架自己的 app 源码；
- Solid/Vue 共用的 main 入口；Octane 参与时有独立入口。

统一的是场景，例如创建 1000 行、反转 keyed list、一个源扇出到 100 个 Text。
组件边界、state ownership、调度和最终树都可以不同。cases/manifest.test.ts
钉住当前 10 个场景及每个实现声明的 action。

### Idiomatic app

vendor/pocketjs/apps 中现有的 cards、gallery、hero、library、music、
notifications、settings、stats 用作真实宏场景。harness/apps.json 只保存确定性输入脚本。

### Neutral corpus

corpus/generate.ts 直接生成 MutationTape，不依赖框架。当前矩阵为：

| family | scale |
|---|---|
| wide | 10、100、1000 |
| deep | 8、32、64 |
| list-ops | 100、1000 |
| animation | 10、100 |

三点 family 用来识别固定成本和非线性，二点 family 提供最小尺度斜率。完整 benchmark
保留全部 10 条。快速 smoke 可以只跑 wide-10、deep-64、list-ops-100、
animation-10，但不能用它更新性能 baseline。

生成测试会把内存生成结果逐字节对照已提交 tape/index，并检查 wide/deep 拓扑、
list 的逐帧结构操作和 animation 的 tween/tick 布局。

## 4. Case 协议

bundle 在 globalThis.__bench 暴露：

- version 与 case；
- 有序 actions；
- run(action)；
- post(action)；
- 可选 reset()。

每个 action 依次执行 js、jobs、tick、draw、render、verify。post 返回 true时立即 settle；
否则 framebuffer hash 连续两次与上一帧相同即 settle；达到 max_settle 仍不稳定则记录失败。
frames 和 stable 每个 action 清零，上一帧 hash 跨 action 保留。

warmup 不写入正式结果；支持 reset 的 case 在 warmup 后恢复初态。first 与 steady
用于观察同一绝对 action 的首次和重复成本。

## 5. Shell 与模式

shell/main.c 是协议、四种模式和 JSONL 输出的唯一 driver：

| mode | 路径 | 用途 |
|---|---|---|
| full | QuickJS → core → DrawList → RGBA8 | host 正式报告 |
| guest-tape | QuickJS + 录制的 HostOps 返回值 | 隔离 guest 行为 |
| native | MutationTape → core → DrawList → RGBA8 | neutral corpus 与 QEMU |
| raster | DrawListTape → RGBA8 | 单独观察软件光栅 |

measure binary 只保留阶段边界与 settle 所需信息。observe binary 经生成 wrapper
记录 HostOps、节点、字节和可选 tape。guest-tape 使用独立 binary，任何 op、参数、
返回值或帧边界差异都退出。

Date.now 使用固定 epoch 加虚拟帧时间；core tick rate 与 CLI/tape 中的 tick_hz 同步。
host 阶段使用线程 CPU 时间，SO3 build 在相同源码位置发 marker。

## 6. Tape 与生成代码

spec/tape.ts 是 MutationTape 与 DrawListTape 的单一事实来源。gen-c.ts 和
gen-rust.ts 生成：

- shell/generated/pocket_tape.h；
- record/tape wrapper 的 C 与 header；
- crates/pocket-bench/src/tape_spec.rs。

生成测试逐字节检查提交产物。MutationTape 中每个有返回值的 op 后必须紧跟 RET；
replayer 维护 tape id 到 live id 的映射并累计 mismatch。DrawListTape 保存前帧、
当前帧和可选基底 framebuffer，以重放半透明绘制历史。

## 7. QEMU 参考机

两个 profile 都固定一个 CPU、关闭 NET/FB/SMC911X、使用 256 KB 用户线程栈。
ARM32 C flags 与 Rust target 均为 ARMv7-A Thumb-2 hard-float。

pocketcount 根据 ELF link map 把 PC 分为 quickjs、core、raster、libc、shell、
kernel 或 other。普通 marker 更新 frame/stage；stage 8 marker 切换 run_id。
runner 在看到 manifest 中全部 end 后主动停止 QEMU，让 plugin 写出结果。

确定性只比较非 idle 数据。idle 包含 boot、进程间工作和停止前空转。verify 是全帧 hash，
单独报告但不作为 workload 成本。详见 ref/README.md 与 plugin/README.md。

## 8. 结果与 identity

结果 schema 位于 spec/results.ts。identity 至少记录：

- PocketJS/benchmark/QuickJS revision 和框架版本；
- bundle、pak、styles、atlas hash；
- Rust、LLVM、C toolchain 与 target；
- SO3、defconfig、musl、QEMU、machine、CPU、icount 和 plugin；
- sim_hz、tick_hz、viewport、pixel format、op capabilities、arena limit 与 runner class。

任一可能影响结果的 identity 字段变化都应创建新 baseline namespace。compare.ts
对计数类给出精确 delta，对 CPU 时间使用 median 与可选 bootstrap CI；报告差异，
当前不强制接受或拒绝变更。

## 9. 当前状态

- 10 个 canonical case、29 个参与框架实现；
- 8 个 idiomatic app 的输入脚本；
- full、guest-tape、native、raster 四种模式已验证；
- host measure/observe 结果与各自 oracle 并排记录；
- virt32/virt64 在固定 QEMU 10.0.11 上完成 10 tape × 2；
- pocketcount v2 的 run ownership、marker 和非 idle 确定性已验证；
- compare、report、host baseline 与 GitHub Actions host job 可用。

已发现的问题记录在 docs/FINDINGS.md。

## 10. 后续工作

1. 固化从空目录构建 SO3 userland、U-Boot、rootfs 与基础 sdcard 的流水线；
2. 为 QEMU reference 建立独立、非门禁的 CI job 与当前 schema baseline；
3. 扩充 lifecycle、async、input、focus、hitTest 和 layout-affecting animation；
4. 如需要设备像素格式观测，再设计 RGB565 输出字段、oracle 与 baseline 后接入，
   不保留无消费者的半套 ABI；
5. 将 vendor/pocketjs 的 soft-host commit 推送到可由 fresh clone 获取的远端。
