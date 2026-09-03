# Case 协议

一个 case 是一个 PocketJS app（`cases/<id>/`），三个框架各一份变体，外加 `case.json`。它与设备上的 app 只有一处不同：bundle 在 eval 时把一个 `globalThis.__bench` 对象交给 host。类型在 `spec/protocol.ts`。

## `globalThis.__bench`

```ts
globalThis.__bench = {
  version: 1,
  case: "list-create",
  actions: ["create", "clear"],
  run(action) { /* 发起状态变化 */ },
  post(action) { /* 是否已达 postcondition */ return true; },
  reset() { /* 可选：回到初始状态 */ },
};
```

- `run(action)` 在该 action 第一帧的 `frame()` **之前**、同一个 `js` 段内被调用。它只发起变化（写 signal / ref / state），不等待任何东西。
- `post(action)` 在每帧 render **之后**被询问。它读自己的状态回答"完成了没有"——例如列表长度是否到了 1000、文本是否已是目标值。不要在 `post` 里改状态。
- `reset()` 可选。有它的 case 才能 `warmup > 0`：warmup 跑完整个 action 列表后调一次 `reset()`，再正式计时。
- `post("mount")` 会在挂载阶段被询问；直接返回 `true` 即可，挂载靠下面的 hash 稳定规则收口。

## settle 规则

两台 host（bench shell 与 wasm oracle）实现同一条规则，逐字相同：

每帧 render 之后，

1. `post(action)` 为 `true` → 本帧 settle；
2. 否则，本帧 fb hash 与上一帧相等且是连续第 2 次相等 → settle；
3. 否则，已跑满 `max_settle` 帧 → `settled=false`，`settle_frames=max_settle`。

`settle_frames` 计从 action 第一帧到 settle 帧的帧数（含两端）。`max_settle` 来自 `case.json`，默认 120。

## 一个 case 的执行顺序

```
eval bundle                              → 段 eval
mount：frame() 直到 settle               → 段 js / jobs / tick / draw / render × 帧
warmup × K：对每个 action 跑 run → frames → settle（不计入结果），然后 reset()
first：对每个 action 跑 run → frames → settle（计入，iteration = "first"）
steady：对每个 action 再跑一遍（iteration = "steady"）；没有 reset 的 case 只有 first
```

每个 action settle 时记录 DrawList hash（`ui_draw_hash`，FNV-1a 64）与 framebuffer hash（FNV-1a 32 over RGBA8，与 `hosts/sim` 同一算法），以及 op 计数、节点计数、jobs 数、DrawList word 数、QuickJS 内存。哪个 host 出哪些字段见 `docs/PLAN.md` §2。

## `case.json`

```json
{
  "id": "list-create",
  "family": "list",
  "track": "canonical",
  "scale": 1000,
  "frameworks": ["solid", "vue-vapor", "octane"],
  "entry": "main.tsx",
  "actions": ["create", "clear"],
  "warmup": 1,
  "max_settle": 120,
  "description": "keyed 列表一次性创建 1000 行，再清空"
}
```

## 目录与构建

```
cases/<id>/
  case.json
  main.tsx            Solid 与 Vue Vapor 共用的入口（mount(() => <App />)）
  main.octane.tsx     Octane 入口（mount(App)）
  app.tsx             Solid 变体
  app.vue-vapor.tsx   Vue Vapor 变体
  app.octane.tsx      Octane 变体
```

变体文件名遵守 `vendor/pocketjs/tools/build.ts` 的规则：请求 `X.tsx` 时按框架换成 `X.vue-vapor.tsx` / `X.octane.tsx`，不存在则用原文件。产物名是 `<id>.js`、`<id>.vue-vapor.js`、`<id>.octane.js`。

case 的 import 与主仓 app 完全一样（`@pocketjs/framework/components`、`solid-js`、`vue`、`octane`……）。为了让这些裸标识符解析到 **submodule 自己的** `node_modules`（只能有一份 `solid-js`），`harness/build.ts` 先把 case 目录复制到 `vendor/pocketjs/.pocket-build/bench-cases/<id>/`（该目录被 submodule 的 `.gitignore` 忽略），再对复制件调用 `tools/build.ts`。case 源码里不要写依赖复制位置的相对路径。

## canonical 场景标准

`canonical` 表示由 `case.json` 定义的通用 micro workload：场景名称、规模、action 顺序、warmup 与 settle 上限统一。Solid、Vue Vapor、Octane 各自用适合自己的代码实现这个场景；它们不需要具有相同的组件结构、状态组织、HostOps 序列、native tree、DrawList 或最终画面。

benchmark harness 只负责按同一协议驱动每个 bundle、完整记录结果并在报告中并排展示，不判断不同框架的实现是否等价或孰优孰劣。同一 bundle 在 sim oracle 与其他 host 上的 hash 比较也是一项观测结果，不是跨框架一致性约束。

## 宏场景

`vendor/pocketjs/apps/` 里已有三变体的 app 没有 `__bench`。harness 用输入 tape（`--frames N --input "f:mask,..."`）驱动它们，帧列表即 action 列表：整段 tape 记为一个名为 `tape` 的 action。
