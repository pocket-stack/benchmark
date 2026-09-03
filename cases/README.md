# cases/ — 通用 micro workload

每个 case 一个目录：`case.json` 定义场景名称、family、规模、action 顺序、warmup 和 settle 上限；`app.tsx`、`app.vue-vapor.tsx`、`app.octane.tsx` 是各框架各自的实现脚本，实际参与的框架以 manifest 的 `frameworks` 为准。

统一的是测试场景而不是实现结果。例如 `list-create@1000` 表示创建 1000 行再清空，`list-ops@1000` 表示依次执行 append / insert / update / swap / reverse / remove / clear。不同框架可以采用不同的组件结构、状态组织、调度方式和 native tree；harness 不要求它们的 hash、HostOps 或输出一一相同，只负责执行和记录足够详细的观测数据。

当前覆盖 mount、reactive、list、animation 与 soak 场景。`manifest.test.ts` 钉住 workload 清单、规模、action 和参与框架，并检查每个实现暴露的协议声明；它不评价实现方式或跨框架结果。

idiomatic macro 不在这里：直接用 `vendor/pocketjs/apps/` 里已有三变体的 8 个 app，input script 从 `tools/bench-ppsspp.ts` 的 `SPECS` 迁移。
