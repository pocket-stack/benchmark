#!/usr/bin/env bash
# Build one compact, immutable SO3 boot artifact containing the shell and every
# neutral MutationTape. Each command receives a stable --run-id; pocketcount v2
# reports by_run so frame numbers may safely restart in every shell process.
set -euo pipefail

profile=""
so3_root=""
base=""
shell=""
corpus=""
out=""
rootfs=""
sdcard=""
uboot=""
its=""
kernel=""
dtb=""
script_dir="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --so3) so3_root="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --shell) shell="$2"; shift 2 ;;
    --corpus) corpus="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --rootfs) rootfs="$2"; shift 2 ;;
    --sdcard) sdcard="$2"; shift 2 ;;
    --uboot) uboot="$2"; shift 2 ;;
    --its) its="$2"; shift 2 ;;
    --kernel) kernel="$2"; shift 2 ;;
    --dtb) dtb="$2"; shift 2 ;;
    *) echo "prepare-corpus: unknown option $1" >&2; exit 2 ;;
  esac
done

case "$profile" in
  virt32|virt64) ;;
  *) echo "usage: prepare-corpus.sh --profile virt32|virt64 (--base DIR | --so3 TREE) --shell ELF --corpus DIR --out DIR [--rootfs F --sdcard F --uboot F --its F --kernel F --dtb F]" >&2; exit 2 ;;
esac
if [ -z "$shell" ] || [ -z "$corpus" ] || [ -z "$out" ]; then
  echo "prepare-corpus: --shell, --corpus and --out are required" >&2
  exit 2
fi
if { [ -z "$base" ] && [ -z "$so3_root" ]; } || { [ -n "$base" ] && [ -n "$so3_root" ]; }; then
  echo "prepare-corpus: choose exactly one of --base and --so3" >&2
  exit 2
fi
if [ -n "$base" ] && { [ -n "$rootfs" ] || [ -n "$sdcard" ] || [ -n "$uboot" ] || [ -n "$its" ] || [ -n "$kernel" ] || [ -n "$dtb" ]; }; then
  echo "prepare-corpus: --base cannot be combined with individual media overrides" >&2
  exit 2
fi

index="$corpus/index.json"
bench_config="$script_dir/so3/${profile}_bench_defconfig"
base_manifest_sha256=""
if [ -n "$base" ]; then
  rootfs="$base/rootfs.fat"
  sdcard="$base/sdcard.img"
  uboot="$base/u-boot"
  its="$base/resolved.its"
  kernel="$base/so3.bin"
  dtb="$base/${profile}.dtb"
  base_manifest="$base/base.json"
  test -f "$base_manifest" || { echo "prepare-corpus: missing $base_manifest" >&2; exit 1; }
  base_identity="$(python3 - "$base_manifest" "$base" "$profile" "$bench_config" <<'PY'
import hashlib, json, os, sys

manifest_path, base, profile, config_path = sys.argv[1:]
manifest = json.load(open(manifest_path))

def sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

expected_names = {
    "rootfs.fat",
    "sdcard.img",
    "u-boot",
    "resolved.its",
    "so3.bin",
    f"{profile}.dtb",
    "bench_defconfig",
}
if manifest.get("schema_version") != 1 or manifest.get("profile") != profile:
    raise SystemExit(f"prepare-corpus: invalid base manifest for {profile}")
files = manifest.get("files")
if not isinstance(files, dict) or set(files) != expected_names:
    raise SystemExit("prepare-corpus: base manifest has an unexpected file set")
for name, expected in files.items():
    if os.path.basename(name) != name:
        raise SystemExit(f"prepare-corpus: unsafe base file name {name!r}")
    actual = sha(os.path.join(base, name))
    if actual != expected:
        raise SystemExit(f"prepare-corpus: base file {name} hash {actual}, expected {expected}")
config_hash = sha(config_path)
if config_hash != manifest.get("bench_defconfig_sha256"):
    raise SystemExit(
        f"prepare-corpus: repository defconfig hash {config_hash} does not match backend "
        f"{manifest.get('bench_defconfig_sha256')}"
    )
commit = manifest.get("so3_commit")
if not isinstance(commit, str) or not commit:
    raise SystemExit("prepare-corpus: base manifest has no SO3 commit")
manifest_hash = sha(manifest_path)
backend_path = os.path.normpath(os.path.join(base, "..", "backend.json"))
if os.path.isfile(backend_path):
    backend = json.load(open(backend_path))
    if (
        backend.get("schema_version") != 1
        or backend.get("bases", {}).get(profile) != manifest_hash
    ):
        raise SystemExit(
            f"prepare-corpus: {profile} base manifest is not owned by backend.json"
        )
print(commit, manifest_hash)
PY
)"
  read -r so3_commit base_manifest_sha256 <<<"$base_identity"
  its_root="$base"
else
  rootfs="${rootfs:-$so3_root/so3/rootfs/rootfs.fat}"
  sdcard="${sdcard:-$so3_root/filesystem/sdcard.img.$profile}"
  uboot="${uboot:-$so3_root/u-boot/u-boot}"
  its="${its:-$so3_root/build/meta-bsp/recipes-bsp/so3/files/its/${profile}_so3.its}"
  kernel="${kernel:-$so3_root/so3/so3/so3.bin}"
  dtb="${dtb:-$so3_root/so3/so3/dts/${profile}.dtb}"
  so3_commit="$(git -C "$so3_root" rev-parse HEAD 2>/dev/null || true)"
  its_root="$so3_root"
fi

for tool in mcopy mdir mkimage python3; do
  command -v "$tool" >/dev/null || { echo "prepare-corpus: missing $tool" >&2; exit 1; }
done
for file in "$rootfs" "$sdcard" "$uboot" "$its" "$kernel" "$dtb" "$shell" "$index" "$bench_config"; do
  test -f "$file" || { echo "prepare-corpus: missing $file" >&2; exit 1; }
done
if [ -e "$out" ] && [ "$(find "$out" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  echo "prepare-corpus: $out is not empty" >&2
  exit 1
fi
mkdir -p "$out"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$rootfs" "$tmp/rootfs.fat"
cp "$shell" "$tmp/pocket-bench-shell"

python3 - "$index" "$tmp/commands.ini" "$tmp/tapes.list" "$corpus/tapes" <<'PY'
import json, os, sys

index_path, commands_path, list_path, tapes_dir = sys.argv[1:]
entries = json.load(open(index_path))

def fnv1a64(data):
    value = 0xcbf29ce484222325
    for byte in data:
        value ^= byte
        value = (value * 0x100000001b3) & 0xffffffffffffffff
    return f"{value:016x}"

with open(commands_path, "w") as commands, open(list_path, "w") as names:
    for run_id, entry in enumerate(entries, 1):
        file = entry["file"]
        path = os.path.join(tapes_dir, file)
        data = open(path, "rb").read()
        if len(data) != entry["bytes"] or fnv1a64(data) != entry["fnv1a64"]:
            raise SystemExit(f"prepare-corpus: {file} differs from corpus/index.json")
        names.write(file + "\n")
        commands.write(
            f"run pocket-bench-shell --mode native --tape {file} --out - --run-id {run_id}\n"
        )
    commands.write("shell\n")
PY

# FAT timestamps and FIT timestamps are pinned so rebuilding from the same base
# inputs produces the same boot payload.
touch -t 198001010000 "$tmp/pocket-bench-shell" "$tmp/commands.ini"
mcopy -o -m -i "$tmp/rootfs.fat@@1M" "$tmp/pocket-bench-shell" ::pocket-bench-shell
mcopy -o -m -i "$tmp/rootfs.fat@@1M" "$tmp/commands.ini" ::commands.ini
while IFS= read -r file; do
  cp "$corpus/tapes/$file" "$tmp/$file"
  touch -t 198001010000 "$tmp/$file"
  mcopy -o -m -i "$tmp/rootfs.fat@@1M" "$tmp/$file" ::"$file"
done < "$tmp/tapes.list"

python3 - "$its" "$tmp/resolved.its" "$its_root" "$tmp/rootfs.fat" "$kernel" "$dtb" <<'PY'
import re, sys

source, target, so3_root, rootfs, kernel, dtb = sys.argv[1:]
text = open(source).read()
text = text.replace("${IB_SO3_PATH}", so3_root + "/so3")
text = text.replace("${IB_ROOTFS_PATH}", so3_root + "/so3/rootfs")

for label, pattern, path in (
    ("kernel", r'data\s*=\s*/incbin/\("[^"]*so3\.bin"\);', kernel),
    ("dtb", r'data\s*=\s*/incbin/\("[^"]*\.dtb"\);', dtb),
    ("rootfs", r'data\s*=\s*/incbin/\("[^"]*rootfs\.fat"\);', rootfs),
):
    text, count = re.subn(pattern, f'data = /incbin/("{path}");', text, count=1)
    if count != 1:
        raise SystemExit(f"prepare-corpus: could not replace the {label} incbin in the ITS")
open(target, "w").write(text)
PY

SOURCE_DATE_EPOCH=315532800 mkimage -f "$tmp/resolved.its" "$tmp/so3.itb" >/dev/null
touch -t 198001010000 "$tmp/so3.itb"

# SO3 standalone only reads partition 1. Keep that partition and clear the
# unused ext4 partition entry, shrinking the 2 GiB development image to ~129 MiB.
python3 - "$sdcard" "$tmp/sdcard.img" <<'PY'
import struct, sys

source, target = sys.argv[1:]
with open(source, "rb") as src:
    mbr = bytearray(src.read(512))
    start, sectors = struct.unpack_from("<II", mbr, 446 + 8)
    if start == 0 or sectors == 0:
        raise SystemExit("prepare-corpus: sdcard has no first partition")
    end = (start + sectors) * 512
    mbr[462:478] = b"\0" * 16
    with open(target, "wb") as dst:
        dst.write(mbr)
        remaining = end - 512
        while remaining:
            chunk = src.read(min(8 * 1024 * 1024, remaining))
            if not chunk:
                raise SystemExit("prepare-corpus: sdcard ended inside partition 1")
            dst.write(chunk)
            remaining -= len(chunk)
PY

offset="$(python3 - "$tmp/sdcard.img" <<'PY'
import struct, sys
with open(sys.argv[1], "rb") as f:
    mbr = f.read(512)
print(struct.unpack_from("<I", mbr, 446 + 8)[0] * 512)
PY
)"
itb_name="$(mdir -b -i "$tmp/sdcard.img@@$offset" :: | sed -n 's|.*/||p' | grep -i '\.itb$' | head -1)"
test -n "$itb_name" || { echo "prepare-corpus: no .itb on sdcard partition 1" >&2; exit 1; }
mcopy -o -m -i "$tmp/sdcard.img@@$offset" "$tmp/so3.itb" ::"$itb_name"

cp "$tmp/sdcard.img" "$out/sdcard.img"
cp "$uboot" "$out/u-boot"
cp "$tmp/rootfs.fat" "$out/rootfs.fat"
cp "$tmp/so3.itb" "$out/so3.itb"
cp "$tmp/resolved.its" "$out/resolved.its"
cp "$tmp/commands.ini" "$out/commands.ini"
cp "$tmp/pocket-bench-shell" "$out/pocket-bench-shell"
cp "$index" "$out/corpus-index.json"

python3 - "$profile" "$index" "$shell" "$out" "$bench_config" "$so3_commit" "$base_manifest_sha256" <<'PY'
import hashlib, json, os, sys

profile, index_path, shell_path, out, config_path, so3_commit, base_manifest_sha256 = sys.argv[1:]
entries = json.load(open(index_path))

def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

manifest = {
    "schema_version": 1,
    "profile": f"so3-{profile}-bench",
    "so3_commit": so3_commit or None,
    "bench_defconfig_sha256": sha(config_path),
    "shell_sha256": sha(shell_path),
    "corpus_index_sha256": sha(index_path),
    "runs": [
        {
            "run_id": run_id,
            "file": entry["file"],
            "family": entry["family"],
            "scale": entry["scale"],
            "frames": entry["frames"],
            "tape_fnv1a64": entry["fnv1a64"],
        }
        for run_id, entry in enumerate(entries, 1)
    ],
    "artifacts": {
        name: sha(os.path.join(out, name))
        for name in (
            "u-boot",
            "sdcard.img",
            "rootfs.fat",
            "so3.itb",
            "commands.ini",
            "pocket-bench-shell",
            "corpus-index.json",
        )
    },
}
if base_manifest_sha256:
    manifest["backend_base_sha256"] = base_manifest_sha256
with open(os.path.join(out, "runs.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

echo "prepare-corpus: ${profile} $(wc -l < "$tmp/tapes.list" | tr -d ' ') runs -> $out"
