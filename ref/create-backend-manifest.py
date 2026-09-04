#!/usr/bin/env python3
"""Create deterministic identity manifests for the reference backend image."""

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--so3-commit", required=True)
    parser.add_argument("--qemu-version", required=True)
    parser.add_argument("--rust-toolchain", required=True)
    parser.add_argument("--plugin", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    base_hashes: dict[str, str] = {}
    for profile in ("virt32", "virt64"):
        directory = args.root / profile
        names = (
            "rootfs.fat",
            "sdcard.img",
            "u-boot",
            "resolved.its",
            "so3.bin",
            f"{profile}.dtb",
            "bench_defconfig",
        )
        manifest = {
            "schema_version": 1,
            "profile": profile,
            "so3_commit": args.so3_commit,
            "bench_defconfig_sha256": sha256(directory / "bench_defconfig"),
            "files": {name: sha256(directory / name) for name in names},
        }
        path = directory / "base.json"
        write_json(path, manifest)
        base_hashes[profile] = sha256(path)

    write_json(
        args.out,
        {
            "schema_version": 1,
            "platform": "linux/amd64",
            "so3_commit": args.so3_commit,
            "qemu_version": args.qemu_version,
            "rust_toolchain": args.rust_toolchain,
            "pocketcount_sha256": sha256(args.plugin),
            "bases": base_hashes,
        },
    )


if __name__ == "__main__":
    main()
