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

    cmake --preset host
    cmake --build --preset host

This produces:

| binary | purpose |
|---|---|
| pocket-bench-shell | measure observer; full, native and raster modes |
| pocket-bench-shell-observe | HostOps counters and optional tape recording |
| pocket-bench-shell-guest | guest-tape mode with recorded native answers |

The SO3 presets build only the measure shell. ref/build-tools.sh runs CMake
inside the digest-locked backend; CMake builds the Rust archive before linking.
When invoking the presets outside that backend, provide the same Rust targets
and point the corresponding environment variable at the musl compiler:

    cargo build --release --manifest-path crates/pocket-bench/Cargo.toml \
      --target armv7-unknown-linux-musleabihf
    POCKET_SO3_CC_ARM32=/path/to/arm-linux-musleabihf-gcc cmake --preset so3-arm32
    cmake --build --preset so3-arm32

    cargo build --release --manifest-path crates/pocket-bench/Cargo.toml \
      --target aarch64-unknown-linux-musl
    POCKET_SO3_CC_AARCH64=/path/to/aarch64-linux-musl-gcc cmake --preset so3-aarch64
    cmake --build --preset so3-aarch64

ARM32 is fixed to ARMv7-A Thumb-2 hard-float. Both targets are static musl ELFs
and emit a GNU link map used by plugin/segmap.ts.

The top-level CMakeLists.txt is the only source list and flag definition.
CMakePresets.json fixes Ninja build directories and output profiles; no
hand-written Makefile is involved.

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
