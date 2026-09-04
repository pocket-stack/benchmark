#!/usr/bin/env bash
# Build both SO3 shell ELFs, their link-derived segment maps, and the pinned
# QEMU+pocketcount runner image. Rust cross targets must already be installed.
set -euo pipefail

toolchain_volume="${POCKET_REF_TOOLCHAIN_VOLUME:-pocketjs-so3-toolchains}"
so3_env_image="${POCKET_REF_SO3_ENV_IMAGE:-ghcr.io/smartobjectoriented/so3-env@sha256:b9affbe7e2375bb70fe5fb5267c30ff4d115d58d0ede89d90d943c882503714f}"
qemu_image="${POCKET_REF_IMAGE:-pocketjs-bench-ref-qemu:10.0.11}"
skip_image_build="${POCKET_REF_SKIP_IMAGE_BUILD:-0}"
root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$root/crates/pocket-bench"
cargo build --release --target aarch64-unknown-linux-musl
cargo build --release --target armv7-unknown-linux-musleabihf

docker run --rm --platform linux/amd64 \
  -v "$root:/repo" \
  -v "$toolchain_volume:/toolchains" \
  -e POCKET_SO3_CC_AARCH64=/toolchains/aarch64-linux-musl/bin/aarch64-linux-musl-gcc \
  -w /repo \
  "$so3_env_image" \
  sh -lc 'cmake --preset so3-aarch64 --fresh && cmake --build --preset so3-aarch64'

docker run --rm --platform linux/amd64 \
  -v "$root:/repo" \
  -v "$toolchain_volume:/toolchains" \
  -e POCKET_SO3_CC_ARM32=/toolchains/arm-linux-musleabihf/bin/arm-linux-musleabihf-gcc \
  -w /repo \
  "$so3_env_image" \
  sh -lc 'cmake --preset so3-arm32 --fresh && cmake --build --preset so3-arm32'

cd "$root"
bun plugin/segmap.ts dist/shell/so3-aarch64/shell.map \
  --out dist/shell/so3-aarch64/segmap.txt --kernel-base 0xffff800000000000
bun plugin/segmap.ts dist/shell/so3-arm32/shell.map \
  --out dist/shell/so3-arm32/segmap.txt --kernel-base 0xc0000000
if [ "$skip_image_build" != "1" ]; then
  docker build --pull=false -f ref/Dockerfile.qemu -t "$qemu_image" .
else
  docker image inspect "$qemu_image" >/dev/null
fi

echo "build-tools: shells, segmaps and $qemu_image are ready"
