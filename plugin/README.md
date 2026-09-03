# plugin/ — QEMU TCG plugin `pocketcount`

按 (run, segment, stage, frame) 四维计数 `insns`、`loads`、`stores`、`load_bytes`、`store_bytes`；observe 模式另统计唯一 64 B code / data 行数（工作集）。输出 JSON。所有 run 都在 `-icount` 下进行：定时器中断落点只依赖虚拟时钟，内核指令数才逐次相同；runner 每次跑两遍，非 idle `by_run` 完全相同是自检。

**状态：pocketcount v2 已在真实 QEMU 10.0.11 上通过 aarch64、A32 与 Thumb 冒烟。** 每个架构的 5 个 marker（含 run boundary）全命中、`marker_misses=0`；frame 0 `js`、frame 0 `tick`、frame 1 `js` 与手算一致，`by_run[7]` 的逐帧数据也一致。两次普通运行逐字节相同，`-icount shift=0,sleep=off` 运行计数不变。

arm32 同样通过（同一容器的 **qemu-system-arm 10.0.11**，`-M virt -cpu cortex-a15`，`kernel_arm.S`）：**A32 marker（0xE1A01001）与 T32 marker（0x4609，Thumb 段里命中两次）都被识别**，`r1/r2/r3` 读取正确、魔数匹配，frame 0 `js` 3003、frame 0 `tick` 2005、frame 1 `js` 303（与手算相等），零访存、两跑逐字节相同、icount 一致。

**EL0 已在 SO3 virt32 / virt64 全系统实测（2026-09-03）**：两个 profile 都顺序回放全部 10 条 neutral tape，每条 shell 进程先发独立 run boundary，再从 frame 0 开始。每套 990 个 marker 全命中、0 miss；两次 `-icount` 运行的非 idle `by_run` 计数相同，20 个 action hash 与 host native 相同，RET mismatch 为 0。

一个依赖此结论的 shell 侧约定（`shell/main.c`，2026-09-02 起）：**每个计时区间必须闭合**——native 模式 EOF 检测在 JS marker 下发生，检出后立即打 idle marker，否则 action 输出、进程退出、init 拉起下一个进程、ELF eager 加载全部灌进 (js, 最后一帧)（实测 158M 条 kernel 指令记错桶）；逐帧 phase 行的 serial 输出（pl011 忙等，SO3 上每字符数千条指令）同样移到 idle marker 之后再打。

尚未验证：`observe=1` 的工作集统计、多 vCPU 告警路径、QEMU 11.1.0 header 组合（升级 QEMU 必须重跑冒烟）。

**header 版本坑**：`vendor/qemu-plugin.h` 一旦存在,`make` 不会重抓（"if absent"）。树里若留着更新版本的 header（如 11.x/master,`QEMU_PLUGIN_VERSION 5`）,编出的插件在 10.0.x 上报 `plugin requires API version 5, but this QEMU supports only up to version 4` 拒载。对准运行时:删掉 `vendor/qemu-plugin.h` 后 `make QEMU_VERSION=<运行时版本>`（上游 tag `v10.0.11` 存在,header 是 API v4）。

```
-plugin ./libpocketcount.so,segmap=<file>,out=<json>[,observe=1]
```

## marker 协议

一条编译器不会自行生成的"寄存器搬到自己"指令，执行时寄存器携带载荷；在真机上是零成本的 NOP，与 guest OS 无关（不经过 semihosting，也不进内核）。

| 架构 | 指令 | 编码（LE 字节） | 载荷 |
|---|---|---|---|
| AArch64 | `orr x1, x1, x1` | `21 00 01 AA`（0xAA010021） | x1 = stage，x2 = frame，x3 = 0x504B4D4B |
| A32 | `mov r1, r1` | `01 10 A0 E1`（0xE1A01001） | r1 = stage，r2 = frame，r3 = 0x504B4D4B |
| T32 | `mov r1, r1`（16 位） | `09 46`（0x4609） | 同上 |

stage id：0 idle、1 eval、2 js、3 jobs、4 tick、5 draw、6 render、7 verify（`spec/results.ts` 的 `STAGES` 顺序）。特殊 stage 8 是 run boundary：此时 x2/r2 携带 run_id；plugin flush 上一个 run 后切换归属，下一条普通 marker 又把 x2/r2 解释为 frame。

shell 侧（`shell/marks_so3.c`）内联汇编示意：

```c
static inline void pb_mark(uint32_t stage, uint32_t frame) {
#if defined(__aarch64__)
  register uint64_t s __asm__("x1") = stage, f __asm__("x2") = frame, m __asm__("x3") = 0x504B4D4Bu;
  __asm__ volatile(".inst 0xAA010021" : "+r"(s) : "r"(f), "r"(m) : "memory");
#elif defined(__arm__)
  register uint32_t s __asm__("r1") = stage, f __asm__("r2") = frame, m __asm__("r3") = 0x504B4D4Bu;
  __asm__ volatile("mov r1, r1" : "+r"(s) : "r"(f), "r"(m) : "memory");
#endif
}
```

plugin 在翻译期用 `qemu_plugin_insn_data` 匹配字节，只对匹配的指令登记带 `QEMU_PLUGIN_CB_R_REGS` 的执行回调；回调里用 `qemu_plugin_read_register` 读三个寄存器，魔数不对就忽略（`marker_misses` 计数）。

## 计数方式

- 指令数：`qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu` 内联累加到**每个 segment 一个**的 scoreboard 计数器（segment 在翻译期已知，stage 不知）。stage 维度由 marker 回调补上：每次 stage 切换时读各 segment 的累计值，把与上次快照的差归到刚结束的 (stage, frame)。单 vCPU、marker 按程序顺序执行时精确；bench 固定 `-smp 1`。
- 访存：需要字节数，所以每次访问走 `qemu_plugin_register_vcpu_mem_cb` 回调，用 `qemu_plugin_mem_size_shift`。回调只拖慢 QEMU，不改变 `-icount` 下的 guest 指令数。
- 工作集（observe=1）：每个 TB 执行时把它覆盖的 64 B 行加入集合（code），每次访存把 `vaddr >> 6` 加入集合（data）。TB 级近似：TB 内的指令视为全部执行。

## segmap 格式

```
<start_hex> <end_hex> <segment>    # 半开区间，按 start 排序
kernel <hex>                       # PC >= 该地址归 kernel（SO3 内核在高半区）
```

segment 名自由，`other` 保留给未命中的地址。`plugin/segmap.ts` 从 GNU ld 的 map 文件（`-Wl,-Map=`）生成：object 文件名 → `quickjs` / `shell` / `libc` / `core`；Rust staticlib 因 LTO 只有一个 object，`core` 里名字含 `raster` 的符号所在范围拆成 `raster`。

```sh
bun plugin/segmap.ts dist/shell/so3-aarch64/shell.map --out dist/shell/so3-aarch64/segmap.txt --kernel-base 0xffff800000000000
```

## 输出

```json
{
  "plugin": "pocketcount", "version": 2, "arch": "aarch64", "observe": 0,
  "marker_hits": 1234, "marker_misses": 0,
  "segments": ["other", "quickjs", "core", "raster", "libc", "shell", "kernel"],
  "stages": ["idle", "eval", "js", "jobs", "tick", "draw", "render", "verify"],
  "totals": { "insns": 0, "loads": 0, "stores": 0, "load_bytes": 0, "store_bytes": 0 },
  "by_segment_stage": { "quickjs": { "js": { "insns": 0, "...": 0 } } },
  "by_frame": [ { "frame": 0, "by_segment_stage": { } } ],
  "by_run": [ { "run_id": 1, "by_segment_stage": { }, "by_frame": [] } ],
  "working_set": { "code_lines_64b": 0, "data_lines_64b": 0 }
}
```

全零的 (segment, stage) 与没有计数的帧不输出。`harness/run-ref.ts` 校验 manifest 中每个 run_id 都存在、两次运行的非 idle `by_run` 完全相同，并生成 `summary.json`。

## 构建

```sh
make                         # 拉 include/qemu/qemu-plugin.h 到 vendor/（gitignore），编 libpocketcount.so
make check                   # 只做语法检查（macOS 也能跑，需要 glib 头）
make QEMU_VERSION=10.2.0     # 换版本
```

Makefile 的默认 `QEMU_VERSION` 是冒烟实测过的 **10.0.11**；`ref/` 镜像定版时把默认值改成同一版本并重跑 `sh plugin/smoke/run.sh`。

`QEMU_VERSION` 必须与 `ref/` 镜像里的 QEMU 一致：plugin ABI 按版本变化（`QEMU_PLUGIN_VERSION`），QEMU 拒绝加载版本不符的 plugin。需要 QEMU ≥ 9.1（`qemu_plugin_insn_data` 的拷贝式签名、`qemu_plugin_read_register`、scoreboard API）；实测通过的组合是 10.0.11。

## 冒烟测试（`smoke/`）

```sh
sh plugin/smoke/run.sh    # 需要 Docker；构建 pocketcount-smoke 镜像并在容器里跑
```

容器 = Debian trixie + 发行版 QEMU（aarch64 与 arm 两个 system 模拟器）+ 匹配版本的 `qemu-plugin.h`（镜像构建时按安装的 QEMU 版本从上游 tag 拉取）+ `gcc-arm-linux-gnueabihf`。`inside.sh` 在容器里编插件，汇编两个裸机内核（`kernel.S`：aarch64，`-cpu cortex-a53`；`kernel_arm.S`：arm32，`-cpu cortex-a15`，A32 主体 + Thumb 段，两种 marker 编码都覆盖；都链接在 0x40080000，`-M virt -kernel` 直接进入，semihosting 退出——aarch64 `hlt #0xF000`，A32 `svc #0x123456`），每个架构跑三次（两次普通 + 一次 `-icount`），`assert.py --arch <a>` 断言：精确指令数（aarch64：frame 0 `js`=3003 / `tick`=2004、frame 1 `js`=303；arm：3003 / 2005 / 303，含"marker 计入所进入的 stage/frame"规则）、零访存、run 7 归属、marker 各 5 命中 0 漏、两次运行字节相同、icount 计数一致。仓库目录只读挂载进容器，产物都在容器的 /tmp。
