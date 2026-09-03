# ref/ — QEMU + SO3 参考机

virt32 与 virt64 的 benchmark profile 均已在 stock QEMU 10.0.11 上跑通全部
10 条 neutral tape × 2。参考机只报告指令与访存计数，不使用墙钟：

- icount shift=0,sleep=off 固定虚拟执行；
- pocketcount v2 用显式 run_id 隔离同一次 boot 中的多个 shell 进程；
- 每次全套 990 个 marker、0 miss；
- 两次运行的非 idle by_run 计数一致；
- 20 个 action 的 DrawList / RGBA8 hash 与 host native 结果一致，
  replay_mismatches=0。

## 前置条件

当前流程假设已有一棵至少完成过一次 SO3 userland、U-Boot、rootfs 与 sdcard
构建的 SO3 tree。仓库钉住 benchmark kernel 配置、shell/toolchain 构建、
corpus 注入、QEMU runner 和验证逻辑；从空目录重建 SO3 基础系统的流水线仍是后续工作。

默认使用：

- SO3 commit e37b1c2a45429bdb5018fc55f748a27f189bc479；
- so3-env 镜像 digest
  sha256:b9affbe7e2375bb70fe5fb5267c30ff4d115d58d0ede89d90d943c882503714f；
- Docker volume pocketjs-so3-toolchains 中的两套 musl toolchain；
- runner 镜像 pocketjs-bench-ref-qemu:10.0.11。

## 固化流程

    # 1. 两架构 Rust/C shell、link map、segmap，以及固定 QEMU+plugin 镜像。
    ref/build-tools.sh

    # 2. 用提交的 bench defconfig 重建 kernel；脚本退出时恢复外部 SO3 tree。
    docker run --rm --platform linux/amd64 \
      -v "$SO3":/so3 -v "$PWD":/repo:ro -w /so3 \
      ghcr.io/smartobjectoriented/so3-env@sha256:b9affbe7e2375bb70fe5fb5267c30ff4d115d58d0ede89d90d943c882503714f \
      /repo/ref/build-so3-kernel.sh --profile virt32 --so3 /so3

    # 3. 注入 shell 与 corpus/index.json 中的全部 tape，产生紧凑启动 artifact。
    docker run --rm --platform linux/amd64 \
      -v "$SO3":/so3 -v "$PWD":/repo:ro -w /so3 \
      ghcr.io/smartobjectoriented/so3-env@sha256:b9affbe7e2375bb70fe5fb5267c30ff4d115d58d0ede89d90d943c882503714f \
      /repo/ref/prepare-corpus.sh --profile virt32 --so3 /so3 \
        --shell /repo/dist/shell/so3-arm32/pocket-bench-shell \
        --corpus /repo/corpus \
        --out /so3/pocketjs-artifacts/bench-virt32

    # 4. 同一 artifact 跑两次并验证 serial、marker、run_id、hash、RET 与确定性。
    bun harness/run-ref.ts --profile virt32-bench \
      --artifacts "$SO3/pocketjs-artifacts/bench-virt32" \
      --segmap dist/shell/so3-arm32/segmap.txt

virt64 将 virt32 / so3-arm32 替换为 virt64 / so3-aarch64。
若 SO3 tree 当前保存的是另一架构的产物，可以向 prepare-corpus.sh 明确传
--rootfs、--sdcard、--uboot、--its、--kernel 与 --dtb；脚本不会再隐式混用
当前 tree 中另一架构的 kernel。

## Profile

| profile | machine / CPU | kernel base | C/Rust target |
|---|---|---:|---|
| virt32-bench | virt / cortex-a15 | 0xc0000000 | ARMv7-A Thumb-2 hard-float |
| virt64-bench | virt,gic-version=2 / cortex-a72 | 0xffff800000000000 | AArch64 |

两份 defconfig 都固定一个 CPU、256 KB 用户线程栈，并关闭 NET、FB 与
SMC911X。原 virt32 的 64 KB 栈会在 deep-32 越界；只传 -mthumb
又会让 musl GCC 选择不可用的 Thumb-1 hard-float，因此 ARM32 flags 必须保持
-march=armv7-a -mthumb -mfpu=neon -mfloat-abi=hard。

## Artifact 与验证

prepare-corpus.sh 会：

1. 校验每条 tape 的长度与 FNV-1a hash；
2. 写入稳定的 run_id 1..10；
3. 固定 FAT 与 FIT 时间戳；
4. 只保留 SO3 实际读取的 sdcard 启动分区；
5. 生成 runs.json，记录 shell、defconfig、corpus index 和所有启动产物 hash。

相同输入连续准备两次应逐文件 SHA-256 相同。run-ref.ts 默认运行两次，
要求 pocketcount v2，拒绝 marker miss、缺失/重复 run_id、未结束的 serial、
RET mismatch、错误 frame 数以及任意非 idle 计数差异。旧的无 by_run
pocketcount v1 结果不兼容。

idle 包含 U-Boot、进程间工作和停止 QEMU 前的 OS 空转，大小由停止时刻决定，
不进入确定性比较。verify 是全 framebuffer hash，单独成桶，不应混入被测 workload。
原始计数可人工查看：

    python3 ref/counts-summary.py counts-1.json --runs
    python3 ref/counts-summary.py counts-1.json --compare counts-2.json

## 文件

| 文件 | 作用 |
|---|---|
| Dockerfile.qemu | 固定 Debian 基础镜像、QEMU 10.0.11、plugin header 与 pocketcount |
| build-tools.sh | 构建两架构 shell、link map、segmap 和 runner 镜像 |
| build-so3-kernel.sh | 临时应用提交的 bench defconfig 并重建 kernel |
| prepare-corpus.sh | 生成全部 tape 的紧凑、确定性启动 artifact |
| run-qemu.sh | 启动两个 stock-QEMU bench profile |
| counts-summary.py | 查看 aggregate/frame/run 计数及比较两次运行 |
| so3/*_bench_defconfig | 两架构参考机 kernel 配置 |

summary.json 记录 SO3 commit、profile、defconfig、shell、corpus、启动产物、
QEMU image、plugin、segmap、run 映射与重复次数。任一身份字段变化都应进入新的
baseline namespace。
