#!/bin/sh
# plugin/smoke/inside.sh — runs INSIDE the smoke container (see run.sh).
# /plugin is the repo's plugin/ directory, mounted read-only. Builds the
# plugin twice (aarch64 and arm targets share the source; QEMU loads the
# same .so from either emulator), assembles both test kernels, runs each
# three times (twice plain, once under -icount) and asserts the counts.
set -eu

WORK=/tmp/pocketcount-smoke
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

echo "== qemu $(cat /opt/qemu-version)"

# aarch64 kernel: native gcc on a linux/arm64 container, cross otherwise.
CC64=gcc
if [ "$(uname -m)" != "aarch64" ]; then
  apt-get update -qq && apt-get install -y -qq gcc-aarch64-linux-gnu >/dev/null
  CC64=aarch64-linux-gnu-gcc
fi
CC32=arm-linux-gnueabihf-gcc

echo "== build plugin"
gcc -O2 -Wall -Wextra -std=gnu11 -fPIC -shared -I/opt \
    $(pkg-config --cflags glib-2.0) \
    -o libpocketcount.so /plugin/pocketcount.c \
    $(pkg-config --libs glib-2.0)

echo "== build kernels"
$CC64 -nostdlib -static -Wl,--build-id=none -Wl,-Ttext=0x40080000 -Wl,-e,_start \
      -o kernel64.elf /plugin/smoke/kernel.S
$CC32 -nostdlib -static -Wl,--build-id=none -Wl,-Ttext=0x40080000 -Wl,-e,_start \
      -o kernel32.elf /plugin/smoke/kernel_arm.S

run_qemu() {
  system=$1
  cpu=$2
  kernel=$3
  out=$4
  shift 4
  timeout 120 "qemu-system-$system" \
    -M virt -cpu "$cpu" -smp 1 -m 128M \
    -display none -monitor none -nic none -nographic \
    -semihosting \
    "$@" \
    -kernel "$kernel" \
    -plugin "./libpocketcount.so,segmap=/plugin/smoke/segmap.txt,out=$out"
}

smoke_arch() {
  arch=$1
  system=$2
  cpu=$3
  kernel=$4
  echo "== [$arch] run 1"
  run_qemu "$system" "$cpu" "$kernel" "$arch-1.json"
  echo "== [$arch] run 2"
  run_qemu "$system" "$cpu" "$kernel" "$arch-2.json"
  echo "== [$arch] run 3 (icount)"
  run_qemu "$system" "$cpu" "$kernel" "$arch-3.json" -icount shift=0,align=off,sleep=off
  echo "== [$arch] assert"
  python3 /plugin/smoke/assert.py --arch "$arch" "$arch-1.json" "$arch-2.json" "$arch-3.json"
}

smoke_arch aarch64 aarch64 cortex-a53 kernel64.elf
smoke_arch arm arm cortex-a15 kernel32.elf

echo "== smoke OK"
echo "-- aarch64:"
cat aarch64-1.json
echo "-- arm:"
cat arm-1.json
