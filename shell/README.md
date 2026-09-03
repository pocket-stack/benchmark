# shell/ — device-lineage benchmark shell

The shell combines:

- vendor/pocketjs/hosts/soft/pocket_runtime.c for QuickJS embedding and HostOps;
- the five Bellard QuickJS C sources pinned by vendor/quickjs-rs;
- crates/pocket-bench for tape replay, DrawList access and RGBA8 rasterization;
- main.c for drivers, stage boundaries and JSONL output;
- arena.c for exact QuickJS/core allocation accounting and optional limits;
- marks_host.c or marks_so3.c for CPU-time samples or QEMU markers;
- record.c and generated wrappers for the observe build;
- tape_host.c and generated wrappers for guest-tape lockstep replay.

The action protocol lives in main.c. vtime.c shadows gettimeofday so Date.now()
and the QuickJS random seed see deterministic frame time. Host stage timing uses
CLOCK_THREAD_CPUTIME_ID on Linux and thread_info on macOS; QEMU builds emit
register markers instead of reading a clock.

## Build products

    make -C shell host

This produces:

| binary | purpose |
|---|---|
| pocket-bench-shell | measure observer; full, native and raster modes |
| pocket-bench-shell-observe | HostOps counters and optional tape recording |
| pocket-bench-shell-guest | guest-tape mode with recorded native answers |

The SO3 targets build only the measure shell:

    make -C shell so3-arm32 SO3_CC_ARM32=/path/to/arm-linux-musleabihf-gcc
    make -C shell so3-aarch64 SO3_CC_AARCH64=/path/to/aarch64-linux-musl-gcc

ARM32 is fixed to ARMv7-A Thumb-2 hard-float. Both targets are static musl ELFs
and emit a GNU link map used by plugin/segmap.ts.

## Modes

| mode | input | measured path |
|---|---|---|
| full | bundle + pak | QuickJS guest → core → DrawList → RGBA8 |
| native | MutationTape | core replay → DrawList → RGBA8 |
| raster | DrawListTape, plus tape or pak assets | RGBA8 raster only |
| guest-tape | bundle + pak + MutationTape | QuickJS guest with lockstep HostOps answers |

full is the host report source. native is the fixed QEMU corpus path. raster
and guest-tape are diagnostic decompositions; they compare a workload with its
own recording and never require different frameworks to produce equal trees.

All inputs are ordinary files. SO3 artifacts place the shell and tapes in the
RAM rootfs, and commands.ini invokes them exactly as the host CLI does. JSONL
goes to stdout, which QEMU captures from the serial console.

See docs/SHELL.md for CLI and record details, docs/PROTOCOL.md for case
semantics, and ref/README.md for the two reference-machine builds.
