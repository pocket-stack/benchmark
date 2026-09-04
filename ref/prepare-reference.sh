#!/usr/bin/env bash
# Materialize the current corpus on top of one immutable backend boot base.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="${POCKET_REF_BACKEND_LOCK:-$root/ref/backend.lock.json}"
profile=""
out=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    -h|--help)
      echo "usage: ref/prepare-reference.sh --profile virt32|virt64 [--out DIR]" >&2
      exit 2
      ;;
    *) echo "prepare-reference: unknown option $1" >&2; exit 2 ;;
  esac
done

case "$profile" in
  virt32)
    shell_profile=so3-arm32
    ;;
  virt64)
    shell_profile=so3-aarch64
    ;;
  *)
    echo "usage: ref/prepare-reference.sh --profile virt32|virt64 [--out DIR]" >&2
    exit 2
    ;;
esac
out="${out:-$root/dist/ref-artifacts/$profile}"
shell="$root/dist/shell/$shell_profile/pocket-bench-shell"
test -f "$shell" || { echo "prepare-reference: build $shell first" >&2; exit 1; }

"$root/ref/verify-backend.sh" "$lock"
image="$(python3 - "$lock" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["image"])
PY
)"

mkdir -p "$out"
out="$(cd "$out" && pwd)"
docker run --rm --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  -v "$root:/repo:ro" \
  -v "$out:/out" \
  "$image" \
  /repo/ref/prepare-corpus.sh \
    --profile "$profile" \
    --base "/opt/ref/$profile" \
    --shell "/repo/dist/shell/$shell_profile/pocket-bench-shell" \
    --corpus /repo/corpus \
    --out /out

echo "prepare-reference: $profile -> $out"
