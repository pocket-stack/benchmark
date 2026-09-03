#!/usr/bin/env bash
# Launch one fixed reference-machine run. Both profiles use the compact artifact
# produced by prepare-corpus.sh and stock QEMU >= 10 with pocketcount support.
set -euo pipefail

profile=""
artifacts=""
serial="serial.txt"
timeout_s=90
icount_shift=0
plugin=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --artifacts) artifacts="$2"; shift 2 ;;
    --serial) serial="$2"; shift 2 ;;
    --timeout) timeout_s="$2"; shift 2 ;;
    --icount-shift) icount_shift="$2"; shift 2 ;;
    --plugin) plugin="$2"; shift 2 ;;
    *) echo "run-qemu: unknown option $1" >&2; exit 2 ;;
  esac
done

if [ -z "$artifacts" ]; then
  echo "usage: run-qemu.sh --profile virt32-bench|virt64-bench --artifacts DIR [--serial FILE] [--timeout N] [--icount-shift N] [--plugin LIB,ARGS]" >&2
  exit 2
fi

case "$profile" in
  virt32-bench)
    qemu="${POCKET_REF_QEMU:-qemu-system-arm}"
    machine=(-M virt -cpu cortex-a15)
    ;;
  virt64-bench)
    qemu="${POCKET_REF_QEMU:-qemu-system-aarch64}"
    machine=(-M virt,gic-version=2 -cpu cortex-a72)
    ;;
  *)
    echo "run-qemu: profile must be virt32-bench or virt64-bench" >&2
    exit 2
    ;;
esac

sd="$artifacts/sdcard.img"
uboot="$artifacts/u-boot"
for file in "$sd" "$uboot"; do
  test -f "$file" || { echo "run-qemu: missing $file" >&2; exit 1; }
done

extra=(-icount "shift=$icount_shift,sleep=off")
if [ -n "$plugin" ]; then
  extra+=(-plugin "$plugin")
fi

exec timeout "$timeout_s" "$qemu" \
  "${machine[@]}" \
  -smp 1 -m 1024 \
  "${extra[@]}" \
  -display none -monitor none \
  -serial "file:$serial" \
  -no-reboot \
  -snapshot \
  -kernel "$uboot" \
  -device virtio-blk-device,drive=hd0 \
  -drive "if=none,file=$(readlink -f "$sd"),id=hd0,format=raw,file.locking=off" \
  -nic none
