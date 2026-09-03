# corpus/ — 中立 tape

不依赖任何 JS 框架的 MutationTape：`corpus/generate.ts` 按参数直接写 `spec/tape.ts` 的记录流，产物 `corpus/tapes/*.pkmt` 与 `corpus/index.json` 提交进仓库并以 FNV-1a 64 钉住。这是 baseline v0——只测 core + 软件光栅，与框架、adapter 无关；native 模式的 shell 与 `crates/pocket-bench` 的 replayer 以它为输入。

```sh
bun corpus/generate.ts            # 重新生成 corpus/tapes/ 与 index.json（确定性，字节相同）
bun corpus/read.ts corpus/tapes/list-ops-1000.pkmt [--dump]
bun test corpus/generate.test.ts
```

## 家族

| 文件 | 内容 | 帧 |
|---|---|---|
| `wide-{10,100,1000}.pkmt` | 根下 N 个兄弟 View（4×4 色块），之后两个空帧 | 3 |
| `deep-{8,32,64}.pkmt` | 链式嵌套 D 层 View（每层小一圈，带 padding），之后两个空帧；64 是 `MAX_TREE_DEPTH`，最深节点在深度 64，再往下会被 core 静默拒绝 | 3 |
| `list-ops-{100,1000}.pkmt` | 帧 0 建 K 行 keyed 列表（每行 View + 3 个 Text）；帧 1 append K/10；帧 2 中间插入 K/10；帧 3 每第 10 行 replaceText；帧 4 swap（第 1 行与倒数第 2 行）；帧 5 reverse（逐行移到最前）；帧 6 remove 每第 10 行（removeChild 后 destroyNode，模拟 JS 侧 sweep）；帧 7 clear；之后两个空帧 | 10 |
| `animation-{10,100}.pkmt` | N 个绝对定位色块各一条 `animate(translateX, 1000 ms, Linear)`，之后 60 个只有 FRAME 记录的帧 | 61 |

所有 `insertBefore` 都是真实的移动语义（已挂接的 child 先脱离）：reverse 与 swap 保持节点 identity，这就是 keyed 列表在 HostOps 层的形态。

## 记录顺序约定

一条 `FRAME` 记录打开一个虚拟帧；其后直到下一条 `FRAME` 或 `END` 的 `OP` / `RET` 记录都属于这一帧（相当于该帧 guest turn 里发出的 op）。出现在第一条 `FRAME` 之前的记录是 eval 期（挂载前）的 op；中立 corpus 不产生这种记录。replayer 回放一帧 = 应用该帧的 op，然后由 shell 按 `ticks` 字段 tick、draw、render。

每个 `createNode` 得到确定的 tape-id（从 2 递增，`ROOT_ID = 1` 是核心预建的根），写进紧跟的 `RET`；`animate` 的 anim id 从 1 递增。replayer 维护 tape-id → live-id 映射，并可以断言真实 core 返回的 id 与 tape 一致（同一 core 版本的分配顺序是确定的）。

## 限制

- 没有 `styles.bin`：样式全部用 `setProp`（`PROP.width / height / bgColor / flexDir / gap / posType / inset*`），不用 `setStyle`。
- 没有字体 atlas：`setText` 的文本会进入布局但测量宽度为 0，像素里没有 glyph。文本节点的开销（创建、布局占位、`replaceText`）仍被测到；glyph 光栅要靠 framework-derived tape。
- `hitTest` / `measureText` 等查询 op 不出现在中立 corpus 里。
- `index.json` 里的 `fnv1a64` 是整个文件的 hash；`bytes` 是文件长度。`list-ops-1000` 约几百 KB。

## framework-derived tape

shell observe 可以为单个 framework workload 录制 tape，用于 guest/native/raster 诊断。
这类 tape 绑定框架版本、adapter 版本与 Host ABI，目前不作为 neutral corpus 提交；
需要归档时必须进入独立 namespace 并显式 refresh。
