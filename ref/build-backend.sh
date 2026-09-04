#!/usr/bin/env bash
# Bootstrap the immutable reference backend image from already-verified SO3
# media. Routine benchmark runs consume the resulting digest and never rebuild
# this image.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tag="pocketjs-bench-ref-backend:dev"
toolchain_volume="${POCKET_REF_TOOLCHAIN_VOLUME:-pocketjs-so3-toolchains}"
so3_commit="${POCKET_REF_SO3_COMMIT:-e37b1c2a45429bdb5018fc55f748a27f189bc479}"
seed=""
base32=""
kernel32=""
base64=""
kernel64=""
publish=0
lock=""

usage() {
  cat >&2 <<'EOF'
usage: ref/build-backend.sh --seed IMAGE@sha256:... [--tag IMAGE]
       [--push] [--lock FILE]

   or: ref/build-backend.sh [--tag IMAGE] [--toolchain-volume VOLUME]
       --base32 DIR --kernel32 DIR --base64 DIR --kernel64 DIR
       [--push] [--lock FILE]

--seed reuses immutable SO3 media and installed toolchains from an existing
backend. The directory form bootstraps a replacement seed from external builds.
--baseXX contains rootfs.fat, sdcard.img, u-boot and resolved.its.
--kernelXX contains so3.bin and virtXX.dtb.
--lock is only valid with --push and records the published image digest.
EOF
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --seed) seed="$2"; shift 2 ;;
    --toolchain-volume) toolchain_volume="$2"; shift 2 ;;
    --base32) base32="$2"; shift 2 ;;
    --kernel32) kernel32="$2"; shift 2 ;;
    --base64) base64="$2"; shift 2 ;;
    --kernel64) kernel64="$2"; shift 2 ;;
    --push) publish=1; shift ;;
    --lock) lock="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "build-backend: unknown option $1" >&2; usage ;;
  esac
done

if [ -n "$seed" ]; then
  if [ -n "$base32$kernel32$base64$kernel64" ]; then
    echo "build-backend: --seed cannot be combined with base directories" >&2
    exit 2
  fi
  if [[ ! "$seed" =~ @sha256:[0-9a-f]{64}$ ]]; then
    echo "build-backend: --seed must be an immutable sha256 reference" >&2
    exit 2
  fi
else
  if [ -z "$base32" ] || [ -z "$kernel32" ] || [ -z "$base64" ] || [ -z "$kernel64" ]; then
    usage
  fi
fi
if [ -n "$lock" ] && [ "$publish" != 1 ]; then
  echo "build-backend: --lock requires --push" >&2
  exit 2
fi
command -v docker >/dev/null || { echo "build-backend: missing docker" >&2; exit 1; }
docker buildx version >/dev/null
if [ -z "$seed" ]; then
  for directory in "$base32" "$kernel32" "$base64" "$kernel64"; do
    test -d "$directory" || { echo "build-backend: missing directory $directory" >&2; exit 1; }
  done
  for file in rootfs.fat sdcard.img u-boot resolved.its; do
    test -f "$base32/$file" || { echo "build-backend: missing $base32/$file" >&2; exit 1; }
    test -f "$base64/$file" || { echo "build-backend: missing $base64/$file" >&2; exit 1; }
  done
  for pair in "$kernel32/so3.bin" "$kernel32/virt32.dtb" "$kernel64/so3.bin" "$kernel64/virt64.dtb"; do
    test -f "$pair" || { echo "build-backend: missing $pair" >&2; exit 1; }
  done
  docker volume inspect "$toolchain_volume" >/dev/null
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/context/plugin" "$tmp/context/ref/so3"
if [ -n "$seed" ]; then
  docker pull --platform linux/amd64 "$seed"
  docker run --rm --platform linux/amd64 "$seed" \
    cat /opt/ref/backend.json >"$tmp/seed-backend.json"
  so3_commit="$(python3 - "$tmp/seed-backend.json" <<'PY'
import json, re, sys

backend = json.load(open(sys.argv[1]))
commit = backend.get("so3_commit")
if (
    backend.get("schema_version") != 1
    or backend.get("platform") != "linux/amd64"
    or not isinstance(commit, str)
    or not re.fullmatch(r"[0-9a-f]{40}", commit)
):
    raise SystemExit("build-backend: invalid seed backend.json")
print(commit)
PY
)"
  base32="$tmp/base32"
  base64="$tmp/base64"
  kernel32="$base32"
  kernel64="$base64"
  mkdir -p "$base32" "$base64"
  docker run --rm --platform linux/amd64 "$seed" \
    tar -C /opt/toolchains -cf - aarch64-linux-musl arm-linux-musleabihf \
    >"$tmp/context/toolchains.tar"
  docker run --rm --platform linux/amd64 "$seed" \
    tar -C /opt/ref/virt32 -cf - \
      rootfs.fat sdcard.img u-boot resolved.its so3.bin virt32.dtb bench_defconfig \
    | tar -C "$base32" -xf -
  docker run --rm --platform linux/amd64 "$seed" \
    tar -C /opt/ref/virt64 -cf - \
      rootfs.fat sdcard.img u-boot resolved.its so3.bin virt64.dtb bench_defconfig \
    | tar -C "$base64" -xf -
  cmp "$root/ref/so3/virt32_bench_defconfig" "$base32/bench_defconfig" >/dev/null || {
    echo "build-backend: virt32 defconfig changed; bootstrap a new base instead of reusing --seed" >&2
    exit 1
  }
  cmp "$root/ref/so3/virt64_bench_defconfig" "$base64/bench_defconfig" >/dev/null || {
    echo "build-backend: virt64 defconfig changed; bootstrap a new base instead of reusing --seed" >&2
    exit 1
  }
else
  docker run --rm \
    -v "$toolchain_volume:/source:ro" \
    debian:trixie@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1 \
    tar -C /source -cf - aarch64-linux-musl arm-linux-musleabihf \
    >"$tmp/context/toolchains.tar"
fi
cp "$root/CMakeLists.txt" "$tmp/context/CMakeLists.txt"
cp "$root/plugin/pocketcount.c" "$tmp/context/plugin/pocketcount.c"
cp "$root/ref/create-backend-manifest.py" "$tmp/context/ref/create-backend-manifest.py"
cp "$root/ref/so3/virt32_bench_defconfig" "$tmp/context/ref/so3/virt32_bench_defconfig"
cp "$root/ref/so3/virt64_bench_defconfig" "$tmp/context/ref/so3/virt64_bench_defconfig"

mode=(--load)
if [ "$publish" = 1 ]; then
  mode=(--push)
fi
cache=()
if [ -n "${POCKET_REF_BUILDX_CACHE_FROM:-}" ]; then
  cache+=(--cache-from "$POCKET_REF_BUILDX_CACHE_FROM")
fi
if [ -n "${POCKET_REF_BUILDX_CACHE_TO:-}" ]; then
  cache+=(--cache-to "$POCKET_REF_BUILDX_CACHE_TO")
fi

docker buildx build \
  --progress plain \
  --platform linux/amd64 \
  --build-context "base32=$base32" \
  --build-context "kernel32=$kernel32" \
  --build-context "base64=$base64" \
  --build-context "kernel64=$kernel64" \
  --build-arg "SO3_COMMIT=$so3_commit" \
  --build-arg "VCS_REF=$(git -C "$root" rev-parse HEAD)" \
  --metadata-file "$tmp/metadata.json" \
  -f "$root/ref/Dockerfile.backend" \
  -t "$tag" \
  "${cache[@]}" \
  "${mode[@]}" \
  "$tmp/context"

digest="$(python3 - "$tmp/metadata.json" <<'PY'
import json, sys
metadata = json.load(open(sys.argv[1]))
print(metadata.get("containerimage.digest", ""))
PY
)"
test -n "$digest" || { echo "build-backend: build returned no image digest" >&2; exit 1; }

if [ -n "$lock" ]; then
  docker run --rm --platform linux/amd64 "$tag@$digest" \
    cat /opt/ref/backend.json >"$tmp/backend.json"
  mkdir -p "$(dirname "$lock")"
  python3 - "$tag" "$digest" "$tmp/backend.json" "$lock" <<'PY'
import hashlib, json, sys

tag, digest, backend_path, target = sys.argv[1:]
backend_bytes = open(backend_path, "rb").read()
backend = json.loads(backend_bytes)
reference = tag.split("@", 1)[0]
last_slash = reference.rfind("/")
last_colon = reference.rfind(":")
image = reference[:last_colon] if last_colon > last_slash else reference
lock = {
    "schema_version": 1,
    "image": f"{image}@{digest}",
    "platform": backend["platform"],
    "so3_commit": backend["so3_commit"],
    "qemu_version": backend["qemu_version"],
    "rust_toolchain": backend["rust_toolchain"],
    "backend_manifest_sha256": hashlib.sha256(backend_bytes).hexdigest(),
    "bases": backend["bases"],
}
with open(target, "w") as output:
    json.dump(lock, output, indent=2)
    output.write("\n")
PY
  echo "build-backend: wrote $lock"
fi

echo "build-backend: $tag@$digest"
