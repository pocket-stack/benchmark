import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../harness/lib.ts";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("reference backend manifest", () => {
  test("identifies every boot-base input deterministically", () => {
    const temp = mkdtempSync(join(tmpdir(), "bench-backend-"));
    const root = join(temp, "ref");
    const plugin = join(temp, "libpocketcount.so");
    const output = join(root, "backend.json");
    writeFileSync(plugin, "plugin");

    for (const profile of ["virt32", "virt64"]) {
      const directory = join(root, profile);
      mkdirSync(directory, { recursive: true });
      for (const name of [
        "rootfs.fat",
        "sdcard.img",
        "u-boot",
        "resolved.its",
        "so3.bin",
        profile + ".dtb",
        "bench_defconfig",
      ]) {
        writeFileSync(join(directory, name), profile + ":" + name);
      }
    }

    const command = [
      "python3",
      join(ROOT, "ref/create-backend-manifest.py"),
      "--root",
      root,
      "--so3-commit",
      "a".repeat(40),
      "--qemu-version",
      "10.0.11",
      "--rust-toolchain",
      "nightly-2026-07-02",
      "--plugin",
      plugin,
      "--out",
      output,
    ];
    const first = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
    expect(first.exitCode).toBe(0);
    const firstBytes = readFileSync(output);
    const backend = JSON.parse(firstBytes.toString());
    expect(Object.keys(backend.bases).sort()).toEqual(["virt32", "virt64"]);
    expect(backend.pocketcount_sha256).toBe(sha256(plugin));

    for (const profile of ["virt32", "virt64"]) {
      const basePath = join(root, profile, "base.json");
      const base = JSON.parse(readFileSync(basePath, "utf8"));
      expect(backend.bases[profile]).toBe(sha256(basePath));
      expect(Object.keys(base.files).sort()).toEqual(
        [
          "bench_defconfig",
          "resolved.its",
          "rootfs.fat",
          "sdcard.img",
          "so3.bin",
          "u-boot",
          profile + ".dtb",
        ].sort(),
      );
    }

    const second = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
    expect(second.exitCode).toBe(0);
    expect(readFileSync(output)).toEqual(firstBytes);
  });
});
