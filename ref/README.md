# ref/ — QEMU + SO3 参考机

参考机 backend 是一个不可变的版本化输入，不是常驻服务，也不是 GitHub Actions
artifact。仓库通过 `backend.lock.json` 锁定一个 GHCR image digest；该镜像同时包含：

- stock QEMU 10.0.11 与 pocketcount plugin；
- ARMv7 hard-float、AArch64 两套 musl 交叉工具链；
- Rust `nightly-2026-07-02` 及两个 cross target；
- CMake、Ninja、mtools、mkimage、dtc；
- virt32、virt64 各自经过验证的 SO3 kernel、DTB、U-Boot、rootfs 与 sdcard base。

当前仓库源码、Rust crate、shell、corpus 和运行结果不在 backend 中。每次 CI 都用
当前 checkout 重新编译 shell，再把当前 `corpus/index.json` 的全部 tape 注入 base。
因此更新 benchmark 代码不需要重建 backend；只有 QEMU、SO3、toolchain、defconfig
或基础介质身份变化时才更新镜像和 lock。

## 日常流程

需要 Docker（能运行 `linux/amd64` image）与 Bun 1.3.14：

```sh
# 拉取 digest，并核对镜像内 backend.json。
ref/verify-backend.sh

# 默认构建两架构；CI matrix 使用 --profile 只构建一个。
ref/build-tools.sh
ref/build-tools.sh --profile virt32

# 校验对应 base manifest，注入当前 shell 与全部 neutral tape。
ref/prepare-reference.sh --profile virt32

# 每个 artifact 完整运行两次。
bun harness/run-ref.ts \
  --profile virt32-bench \
  --artifacts dist/ref-artifacts/virt32 \
  --segmap dist/shell/so3-arm32/segmap.txt
```

virt64 使用 `virt64-bench` 与 `so3-aarch64`。开发者已经有同 digest 的本地镜像时，
可设置 `POCKET_REF_SKIP_PULL=1` 跳过 registry pull；manifest 校验仍会执行。

`prepare-reference.sh` 要求输出目录为空，避免一次运行混入旧介质。底层
`prepare-corpus.sh` 仍保留 `--so3 TREE` 与逐文件 override，供 backend
bootstrap 使用；普通运行应只走 `--base /opt/ref/<profile>`。

## CI 行为

`.github/workflows/ref-bench.yml` 为两个 profile 各开一个 job：

1. 用仓库 token 登录 GHCR 并拉取 lock 中的 digest；
2. 校验 backend identity；
3. 用镜像内工具链编译当前 shell；
4. 从镜像内 base 生成当前 corpus 启动介质；
5. 完整运行 10 条 tape 两次并上传 serial、counts、summary 与 `runs.json`。

认证、拉取、identity、编译和介质准备失败属于基础设施失败，会让 job 失败。
最后的 benchmark observation 使用 `continue-on-error`：缺陷仍在日志和结果中可见，
但当前阶段不作为合并门禁。

Actions artifact 只保存该次运行的观测输出，保留 30 天；后续 job 和后续 workflow
都不从中获取 backend。长期可复用输入只有 GHCR 的不可变 image digest。

## Backend identity

镜像内有三级身份：

- `/opt/ref/backend.json`：SO3 commit、QEMU、Rust、plugin hash 与两个 base hash；
- `/opt/ref/<profile>/base.json`：defconfig 和每个启动文件的 SHA-256；
- corpus artifact 的 `runs.json`：base、shell、corpus、run_id 映射和最终介质 hash。

`verify-backend.sh` 将第一级与仓库 lock 对照；`prepare-corpus.sh --base` 校验第二级，
并要求镜像中的 defconfig 与当前仓库完全一致。这样 tag 被移动、介质损坏或配置漂移
都会在启动 QEMU 前失败。

## 重建与发布 backend

这是低频 maintainer 操作。它需要已有且验证过的 SO3 base 目录，以及
`pocketjs-so3-toolchains` Docker volume 中两套已安装 toolchain；不会把
`musl-cross-make` 源码装进最终镜像。

```sh
ref/build-backend.sh \
  --tag ghcr.io/pocket-stack/benchmark-ref-backend:so3-e37b1c2-qemu10.0.11-v1 \
  --base32 /path/to/bench-virt32 \
  --kernel32 /path/to/kernel-virt32 \
  --base64 /path/to/bench-virt64 \
  --kernel64 /path/to/kernel-virt64 \
  --push --lock ref/backend.lock.json
```

先用本地 tag 重跑两个 profile 的完整 `10 tape × 2`，确认后再 `--push --lock`。
写 lock 需要 GHCR package 写权限；CI 日常运行只需要 `packages: read`。

## Profile

| profile | machine / CPU | kernel base | C/Rust target |
|---|---|---:|---|
| virt32-bench | virt / cortex-a15 | 0xc0000000 | ARMv7-A Thumb-2 hard-float |
| virt64-bench | virt,gic-version=2 / cortex-a72 | 0xffff800000000000 | AArch64 |

两份 defconfig 都固定一个 CPU、256 KB 用户线程栈，并关闭 NET、FB 与 SMC911X。
原 virt32 的 64 KB 栈会在 deep-32 越界；只传 `-mthumb` 又会让 musl GCC
选择不可用的 Thumb-1 hard-float，因此 ARM32 flags 固定为
`-march=armv7-a -mthumb -mfpu=neon -mfloat-abi=hard`。

## 运行校验

pocketcount v2 以显式 `run_id` 隔离同一次 boot 中的多个 shell 进程。
`run-ref.ts` 拒绝 marker miss、缺失或重复的 run_id、未结束 serial、RET mismatch、
错误 frame 数，以及两次运行中任意非 idle 计数或 observation 差异。

idle 包含 U-Boot、进程间工作和停止 QEMU 前的 OS 空转，大小由停止时刻决定，不进入
确定性比较。verify 是全 framebuffer hash，单独成桶，不混入被测 workload。

```sh
python3 ref/counts-summary.py counts-1.json --runs
python3 ref/counts-summary.py counts-1.json --compare counts-2.json
```

## 文件

| 文件 | 作用 |
|---|---|
| `Dockerfile.backend` | 定义唯一的 QEMU/SO3/toolchain backend |
| `backend.lock.json` | 锁定 CI 使用的 registry digest、backend manifest 与两套 base hash |
| `build-backend.sh` | 从已验证介质 bootstrap、发布镜像并更新 lock |
| `verify-backend.sh` | 拉取并验证不可变 backend |
| `build-tools.sh` | 在 backend 中构建当前 SO3 shell 与 segmap |
| `build-so3-kernel.sh` | bootstrap 时临时应用 bench defconfig 并重建 kernel |
| `prepare-reference.sh` | 从 lock 对应 base 生成当前 corpus artifact |
| `prepare-corpus.sh` | 校验、注入并生成确定性启动介质 |
| `run-qemu.sh` | 启动两个 stock-QEMU bench profile |
| `counts-summary.py` | 查看 aggregate/frame/run 计数及比较两次运行 |
| `so3/*_bench_defconfig` | 两架构参考机 kernel 配置 |
