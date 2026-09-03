# Benchmark 抓到的问题与边界

这套 benchmark 存在的意义之一就是把问题钉死成可复现的记录。本页收集已确认的发现；每条都带复现命令。上游修复后在对应条目标注。

## 1. Solid universal renderer：自锚插入在纯反转时抛错且在设备上静默乱序（已修）

keyed `<For>` 纯反转（元素同一、仅整体倒序）时，solid-js `reconcileArrays` 的 swap-ends 分支收敛到相邻交换会发出 `insertNode(parent, node, node)`——DOM 的 pre-insertion 规则定义了它（原位不动），`native-tree.ts` 的 mirror 先 unlink 再找锚点则抛 `insert anchor is not a child of parent`；**抛错前原生 op 已发出，在设备后端上是静默乱序**。Vue / Octane 不走该 reconciler，无恙。

- 复现路径：`bun harness/build.ts --cases list-ops --apps none --frameworks solid`，再运行 `bun harness/oracle.ts --only list-ops.solid`（修复前在 `reverse` action 触发）。6 行、n=2 即可最小复现。
- 修复：主仓 `fix(renderer): DOM pre-insertion semantics for a self-anchored insert`（feat/soft-host 分支 `7df41e0`）——自锚插入按 DOM 语义处理为位置 no-op，不发原生 op。54 张 golden 零像素变化。

## 2. Vue Vapor：QuickJS 路径上的 churn 内存滞留（未修，待上游 issue）

soak-churn（每帧交替创建 200 行 / 清空，共 600 帧）在 Bellard QuickJS 上：

| 框架 | 600 帧后 arena 现存 | steady 再 600 帧后 | jobs_count |
|---|---:|---:|---:|
| Solid | 15 → 20 MB | ~20 MB | 0 |
| Octane | 28 → 41 MB | ~41 MB | 0 |
| **Vue Vapor** | **3.64 GB** | **7.15 GB** | 600（每帧一个 scheduler job） |

随帧线性增长（≈6 MB/帧滞留），hash 全对、行为正确——host 机内存大所以跑完了，**设备上会立刻 OOM**。大栈 JSC（oracle / Bun）上无感，是 QuickJS 路径上的滞留。

时间维度同样超线性（全量 sweep 的 measure 数字，同一 600 帧 churn 跑两轮）：

| 框架 | first 总 CPU | steady 总 CPU | 主要落点 |
|---|---:|---:|---|
| Solid | 6.6 s | 6.9 s | js 段，稳定 |
| Octane | 18.1 s | 18.2 s | js 段，稳定 |
| **Vue Vapor** | **25.4 s** | **103.8 s（4×）** | jobs 段 24.9 s → 103.3 s |

第二轮比第一轮慢 4 倍，与"滞留的订阅让每次 flush 扫描量单调增长"一致——滞留不只是内存问题，也是时间问题。

- 复现：`dist/shell/host/pocket-bench-shell --mode full --js dist/bundles/soak-churn.vue-vapor.js --pak dist/bundles/soak-churn.vue-vapor.pak --bench --warmup 0 --max-settle 1300 --out /tmp/soak.jsonl`，看 action 记录里的 `js_malloc_bytes` / `js_peak_bytes`。
- 嫌疑面：Vue Vapor 的 scheduler / 依赖清理在 `renderer-vue-vapor.ts` 适配路径上的滞留；待最小化并提上游。

## 3. 设备栈边界：256 KB QuickJS 栈下的组件深度

`JS_SetMaxStackSize(256 KB)` 是设备真实值（PSP 主栈模型）。实测：

- **递归组件**（每层一个组件递归渲染）：三框架 **16 层即 `InternalError: stack overflow`**——解释器 C 栈随 JS 调用嵌套增长。deep-tree 因此改为自底向上迭代构造（量 native 树深，48 层正常）。
- **Octane 深链上限 ~8–11 层**（任何写法）：递归组件 ≤16 层溢出；循环动态子链 8 层溢出；单块字面量嵌套 8 层可启动、12 层运行期溢出（plan 走查递归）、48 层解析器直接 `SyntaxError`；双组件折半仍溢出。Octane 已退出 deep-tree（case.json 记录）。
- **`gallery.octane` 宏场景在 256 KB 下挂载失败**：QuickJS 上限 295 KB 仍溢出，296 KB 可完整运行 90 帧。最小化后 `Gallery`、`FocusScope`、`Lazy`、`ActionBar` 分别正常，`Gallery + FocusScope + Lazy` 内联也正常；经额外 `Page` 组件和外层 `View` 组合后溢出，确认是 Octane universal mount 的同步组件 / plan 递归深度叠加，不是 pak、tile 数量、输入或 native core 失败。保留 256 KB 是为了忠实暴露设备边界，不提高默认值来掩盖它。
- 复现：`dist/shell/host/pocket-bench-shell --mode full --js dist/bundles/deep-tree.solid.js …`（把 case 的 DEPTH 改回递归写法/更深即可复现溢出）。

## 4. Octane 结构性约束：hook 不能进循环

Octane 编译器按调用点键 hook，禁止 `for { useState() }`（编译期报错）。reactive-fanin 的"100 个独立 state"在 Octane 只能用 100 个词法独立的 `useState` 调用点（生成代码）表达。写 canonical case 时的已知约束。

## 5. 语义差异记录（不是 bug，但跨框架比较时必须知道）

- **Vue 单个 Text 更新是 2 个 op**（Solid/Octane 1 个）：reactive-single / fanout 一致复现。
- **Vue 的更新全部经过 job 队列**：`js` 段几乎为空、成本落在 `jobs` 段（list-create create：Solid js 108 ms vs Vue jobs 348 ms）。这正是六段计时设计要暴露的。
- **扇入语义**：100 次源写，Solid 每次同步重算 sink（99/100 op），Vue 批到一次 flush（2 op），Octane 一次重渲染（1 op）——reactive-fanin 如实记录，不做"公平化"改写。
- **视口外内容不进 DrawList**：list append/insert 在视口外时 fb/drawlist hash 不变是正确行为（CPU 裁剪），正确性由 post() 的状态断言保证。

## 6. 谱系与宿主事实

- 设备 / C shell 的 QuickJS 是 `pocket-stack/quickjs-rs`（Bellard 2026-06-04）；`pocket-mod` / pocketbook / apple 走 rquickjs 0.12 = **quickjs-ng**，两谱系数字不可混比。
- 半透明 op 沿帧历史混合：DrawListTape 必须带基底帧（`base_fb_words`），prev+cur 两份 DrawList 不足以复现像素；对同一份 words 渲染两次不是同一张画。
- 部分纹理（atlas 页、渐变 LUT）是 draw 期才物化的：raster 重放要在资产重建后做一次不计时 draw。

## 7. SO3 virt32：64 KB 用户线程栈不足以跑 native `deep-32`

最初的 `virt32_defconfig` 使用 `CONFIG_THREAD_STACK_SIZE_KB=64`。neutral corpus 顺序运行时，前四条 tape 正常，`deep-32` 在首帧触发 EL0 data abort：`far=0xbffeed7c`，距用户栈顶 `0xc0000000` 为 70,276 B（约 68.6 KB），与越过 64 KB 映射完全吻合。

参考机 bench profile 现显式使用 256 KB 用户线程栈；重建后 `deep-32`、`deep-64` 及其余 8 条 tape 全部通过，两次 QEMU run 的非 idle `by_run` 计数相同，hash 与 host native 相等。这是参考机画像修正，不改变 PocketJS shell 的 QuickJS 256 KB 栈上限。

## 8. arm32 musl GCC 默认值不是可用的 Thumb-2 目标

原 Makefile 只传 `-mthumb`，`arm-linux-musleabihf-gcc` 因缺少 CPU/FPU 约束而选择 Thumb-1 + hard-float ABI，编译 QuickJS 时失败：`sorry, unimplemented: Thumb-1 'hard-float' VFP ABI`。现在 C 侧固定 `-march=armv7-a -mthumb -mfpu=neon -mfloat-abi=hard`；`readelf -A` 验证它与 Rust `armv7-unknown-linux-musleabihf` 产物同为 ARMv7、Thumb-2、VFP register arguments，C/Rust 静态链接与 SO3 virt32 启动均已通过。
