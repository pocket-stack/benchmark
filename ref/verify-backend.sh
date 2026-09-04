#!/usr/bin/env bash
# Pull the locked backend and prove its in-image identity manifest matches the
# repository lock before any build or benchmark work starts.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="${1:-$root/ref/backend.lock.json}"
test -f "$lock" || { echo "verify-backend: missing $lock" >&2; exit 1; }

identity="$(python3 - "$lock" <<'PY'
import json, re, sys

lock = json.load(open(sys.argv[1]))
required = {
    "schema_version",
    "image",
    "platform",
    "so3_commit",
    "qemu_version",
    "rust_toolchain",
    "backend_manifest_sha256",
    "bases",
}
if set(lock) != required or lock.get("schema_version") != 1:
    raise SystemExit("verify-backend: invalid lock schema")
image = lock["image"]
if not isinstance(image, str) or not re.search(r"@sha256:[0-9a-f]{64}$", image):
    raise SystemExit("verify-backend: image must be locked by sha256 digest")
if lock["platform"] != "linux/amd64":
    raise SystemExit(f"verify-backend: unsupported platform {lock['platform']!r}")
bases = lock.get("bases")
if (
    not isinstance(bases, dict)
    or set(bases) != {"virt32", "virt64"}
    or not all(re.fullmatch(r"[0-9a-f]{64}", value or "") for value in bases.values())
):
    raise SystemExit("verify-backend: invalid base hashes")
print(image, lock["platform"], sep="\t")
PY
)"
IFS=$'\t' read -r image platform <<<"$identity"

if [ "${POCKET_REF_SKIP_PULL:-0}" = 1 ]; then
  docker image inspect "$image" >/dev/null
else
  docker pull --platform "$platform" "$image"
fi
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
docker run --rm --platform "$platform" "$image" cat /opt/ref/backend.json >"$tmp"
python3 - "$tmp" "$lock" <<'PY'
import hashlib, json, sys

path, lock_path = sys.argv[1:]
lock = json.load(open(lock_path))
data = open(path, "rb").read()
actual_hash = hashlib.sha256(data).hexdigest()
if actual_hash != lock["backend_manifest_sha256"]:
    raise SystemExit(
        f"verify-backend: backend.json hash {actual_hash}, "
        f"expected {lock['backend_manifest_sha256']}"
    )
manifest = json.loads(data)
expected = {
    "schema_version": 1,
    "platform": lock["platform"],
    "so3_commit": lock["so3_commit"],
    "qemu_version": lock["qemu_version"],
    "rust_toolchain": lock["rust_toolchain"],
    "bases": lock["bases"],
}
for name, value in expected.items():
    if manifest.get(name) != value:
        raise SystemExit(
            f"verify-backend: backend.json {name}={manifest.get(name)!r}, expected {value!r}"
        )
PY

echo "verify-backend: $image is ready"
