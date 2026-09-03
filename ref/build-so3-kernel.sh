#!/usr/bin/env bash
# Build only the SO3 kernel/dtb for a committed benchmark defconfig.
# Run inside the SO3 build environment with both trees mounted, for example:
#   docker run --rm --platform linux/amd64 -v "$SO3":/so3 -v "$PWD":/repo:ro \
#     -w /so3 ghcr.io/smartobjectoriented/so3-env@<digest-from-ref/README.md> \
#     /repo/ref/build-so3-kernel.sh --profile virt32 --so3 /so3 --out /so3/pocketjs-artifacts/kernel-virt32
set -euo pipefail

profile=""
so3_root=""
out=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --so3) so3_root="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "build-so3-kernel: unknown option $1" >&2; exit 2 ;;
  esac
done

case "$profile" in
  virt32|virt64) ;;
  *) echo "usage: build-so3-kernel.sh --profile virt32|virt64 --so3 <tree> [--out dir]" >&2; exit 2 ;;
esac
if [ -z "$so3_root" ]; then
  echo "build-so3-kernel: --so3 is required" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
source_config="$script_dir/so3/${profile}_bench_defconfig"
target_config="$so3_root/so3/so3/configs/${profile}_bench_defconfig"
local_conf="$so3_root/build/conf/local.conf"
tmp="$(mktemp -d)"
config_existed=0

cleanup() {
  cp "$tmp/local.conf" "$local_conf"
  if [ "$config_existed" -eq 1 ]; then
    cp "$tmp/bench_defconfig" "$target_config"
  else
    rm -f "$target_config"
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

cp "$local_conf" "$tmp/local.conf"
if [ -f "$target_config" ]; then
  config_existed=1
  cp "$target_config" "$tmp/bench_defconfig"
fi
cp "$source_config" "$target_config"
{
  printf '\n# pocketjs-bench temporary override\n'
  printf 'IB_PLATFORM = "%s"\n' "$profile"
  printf 'IB_CONFIG:so3:%s = "%s_bench_defconfig"\n' "$profile" "$profile"
} >> "$local_conf"

cd "$so3_root"
set +u
. ./env.sh
set -u
build.sh -x so3

if [ -n "$out" ]; then
  mkdir -p "$out"
  cp "$so3_root/so3/so3/so3.bin" "$out/so3.bin"
  cp "$so3_root/so3/so3/dts/${profile}.dtb" "$out/${profile}.dtb"
fi
