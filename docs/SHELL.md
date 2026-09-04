# bench shell

`shell/` 是一份 C 源码、两种构建（host / so3）、两种 observer（measure / observe），运行时层来自 `vendor/pocketjs/hosts/soft/pocket_runtime.c`，core 来自 `crates/pocket-bench`（`pocketjs-symbian-core` 的 C ABI 加 bench 扩展）。

## 命令行

```
pocket-bench-shell
  --mode full|guest-tape|native|raster
  --observer measure|observe           只做校验：observer 是构建变体，与二进制不符即退出
  --js app.js --pak app.pak            full / guest-tape
  --tape in.pkmt                       guest-tape：查询的应答来源；native：回放输入
  --dltape in.pkdl                     raster：回放输入
  --bench [--actions a,b,c]            用 globalThis.__bench 驱动（case 协议）；action 列表默认从
                                       __bench.actions 读，给了 --actions 则校验相等
  --frames N --input "f:mask,..."      用输入 tape 驱动（宏场景；与 tools/soft.ts 同一格式）
  --warmup K --max-settle M            协议参数（默认 1 / 120）
  --record-tape out.pkmt               observe：录 MutationTape（含 eval 期的 op）
  --record-dltape out.pkdl             录最后两帧的 DrawListTape
  --run-id N                           参考机 workload id；plugin v2 用它隔离不同进程的 frame 0
  --js-limit BYTES --core-limit BYTES  两块 arena 的上限（min_pass_arena_bytes 扫描）
  --out results.jsonl                  默认 stdout
  --hz 60 --width 480 --height 272     目前只支持 60（pocket_runtime_tick 每帧一个 tick）
```

当前状态：四种模式全部可用并各自验证过。`full` 与 oracle 逐 action 相等；`native` 回放录制 tape 得到与 `full` 相同的 DrawList / fb hash、返回值 0 次不等；`guest-tape` 在 `pocket-bench-shell-guest` 二进制上锁步匹配整条 tape（op 码、每个参数字、帧边界；任何分歧退出 5），两种录制都支持：输入 tape 驱动的宏 app，以及 bench 协议的 case——observe 录制在每次 `run()` 前写一条 ACTION 记录，重放按"消费 FRAME 后再 eval run()"的原始顺序重新发起；`raster` 需要 `--tape`（精确：回放 MutationTape 的 op 与 tick 重建纹理 / atlas，再做一次不计时的 draw 物化 draw 期资源）或 `--pak`（近似），配合 tape 里的基底帧（半透明 op 沿帧历史混合，DrawListTape 记录最后一帧渲染前的累积画面），逐字节复现 `full` 的最终帧。

细节：native 模式里 tape 第一条 FRAME 之前的 op（bundle eval 与 mount）作为 eval 段回放并按 `eval` 报告；每帧的 op 应用没有 JS 在背后，报告在 `js` 段下，六个段名在各模式之间保持同一含义。raster 的重复计时每次迭代前在计时区外恢复基底——对同一份 words 连续渲染两次不是同一张画。`--dump-fb` 在 native / raster 模式把最终 RGBA 写盘，供离线像素对比。

## 模式

| 模式 | 输入 | 跑什么 | 用途 |
|---|---|---|---|
| `full` | bundle + pak | guest → core → raster | 报告来源；六段计时 |
| `guest-tape` | bundle + pak + MutationTape | guest，查询用 tape 里的 RET 应答，不跑 core | 隔离 guest；交叉校验 |
| `native` | MutationTape | core → DrawList → raster | 中立 corpus；ABI 解耦 |
| `raster` | DrawListTape | raster | 软件后端 |

`native` 与 `full` 的 core 分段数据用于观察同一 tape 在两条路径上的差异；`full` 与 oracle 的 hash 按同一 bundle 对照记录。当前仓库以暴露差异为目标，不因这些观测值不同而自动评价实现优劣。

## observer

- `measure`：最少 instrumentation——只有段边界计时与 settle 所需的 fb hash（在 verify 段）。
- `observe`：所有 `ui.*` 调用经过录制包装（op 计数、字节数、返回值、tape 录制），QuickJS 内存统计，DrawList 导出。

两种 observer 是两个二进制（`pocket-bench-shell`、`pocket-bench-shell-observe`），同一源码，`-DPB_OBSERVE` 切换；op 包装靠 `-include generated/record_ops.h` 把 `pocket_runtime.c` 里的 `ui_*` 调用改名到 `pb_rec_ui_*`。

## 段

| 段 | 边界 |
|---|---|
| `eval` | `JS_Eval` 到 bundle 顶层返回并排空 jobs |
| `js` | `__bench.run()`（若有）+ `frame()` 调用 |
| `jobs` | `JS_ExecutePendingJob` 循环 |
| `tick` | `ui_tick × (tick_hz / hz)` |
| `draw` | `pb_draw()`：layout（若脏）+ DrawList |
| `render` | `pb_render_rgba8()`：DrawList → framebuffer |
| `verify` | hash、post()、录制、输出（不计时） |

host 构建的段边界读 `CLOCK_THREAD_CPUTIME_ID`（macOS 用 `thread_info` 的 user+system 时间）；so3 构建打寄存器 marker。`pocket_runtime.c` 用 `POCKET_RUNTIME_BENCH_HOOKS` 编译时暴露 js / jobs / tick 三段的边界（`pocket_bench_stage(stage)`），draw 与 render 由 shell 自己调用 `pb_draw` / `pb_render_rgba8`，绕过 `pocket_runtime_render` 的增量路径——bench 的基线是全帧光栅，damage 属于 backend 层。

## 输出

JSON lines，类型在 `spec/protocol.ts`：

```
{"kind":"identity", ...}
{"kind":"phase","action":"mount","iteration":"first","frame":0,"stage":"js","cpu_us":812}
...
{"kind":"action","action":"create","iteration":"first","settled":true,"settle_frames":2,
 "hashes":{"drawlist":"…16 hex…","fb_rgba8":"…8 hex…"},"metrics":{...}}
{"kind":"end","exit":0}
```

退出码：`1` 用法，`2` boot 失败，`3` 帧失败（stderr 带 `pocket_runtime_error()`），`4` I/O，`5` tape 校验失败（RET 与真实值不等、ABI 不匹配）。

## 构建

顶层 `CMakeLists.txt` 是唯一构建定义：

- `cmake --preset host && cmake --build --preset host`：本机 `cc -O2`；
  QuickJS 五个 C 文件来自钉住的 quickjs-rs，Cargo 使用 crate 自带的 nightly。
- `so3-arm32` / `so3-aarch64` preset：SO3 musl 静态链接、`-Os`；
  ARM32 toolchain 固定 ARMv7-A Thumb-2 hard-float。日常通过
  `ref/build-tools.sh` 构建，直接调用方法见 `shell/README.md`。

host 产物是 measure、observe 与 guest 三个 binary；SO3 target 只生成 measure
binary。精确文件名见 `shell/README.md`。
