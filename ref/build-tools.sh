#!/usr/bin/env bash
# Build SO3 shell ELFs and link-derived segment maps inside the repository's
# digest-locked reference backend.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="${POCKET_REF_BACKEND_LOCK:-$root/ref/backend.lock.json}"
selected="both"

if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--profile" ]; then
    echo "usage: ref/build-tools.sh [--profile virt32|virt64]" >&2
    exit 2
  fi
  selected="$2"
fi
case "$selected" in
  both) profiles=(virt64 virt32) ;;
  virt32|virt64) profiles=("$selected") ;;
  *) echo "build-tools: profile must be virt32 or virt64" >&2; exit 2 ;;
esac

"$root/ref/verify-backend.sh" "$lock"
image="$(python3 - "$lock" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["image"])
PY
)"

container_user="$(id -u):$(id -g)"
cd "$root"
for profile in "${profiles[@]}"; do
  if [ "$profile" = virt64 ]; then
    preset=so3-aarch64
    shell_profile=so3-aarch64
    kernel_base=0xffff800000000000
  else
    preset=so3-arm32
    shell_profile=so3-arm32
    kernel_base=0xc0000000
  fi
  docker run --rm --platform linux/amd64 \
    --user "$container_user" \
    -e HOME=/tmp \
    -e CARGO_HOME=/repo/dist/ref-cargo-home \
    -v "$root:/repo" \
    -w /repo \
    "$image" \
    sh -c "cmake --preset $preset --fresh -DPOCKET_SKIP_CARGO=OFF && cmake --build --preset $preset"
  bun plugin/segmap.ts "dist/shell/$shell_profile/shell.map" \
    --out "dist/shell/$shell_profile/segmap.txt" --kernel-base "$kernel_base"
done

echo "build-tools: $selected SO3 shell(s) and segment map(s) are ready"
