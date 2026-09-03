// harness/run-ref.ts — run and validate a prepared SO3 neutral-corpus image.
// The image's runs.json assigns one stable run_id to every tape. pocketcount v2
// keeps stage/frame counters under that id, so frame 0 from different shell
// processes never collides. Two complete runs are required by default.

import { createReadStream, existsSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { basename, join, resolve } from "node:path";
import { ROOT, ensureDir, gitHead, parseArgs, readJson, run, sha256, wantsHelp, writeJson } from "./lib.ts";

const LABEL = "bench run-ref";

export interface CorpusRun {
  run_id: number;
  file: string;
  family: string;
  scale: number;
  frames: number;
  tape_fnv1a64: string;
}

export interface CorpusManifest {
  schema_version: 1;
  profile: "so3-virt32-bench" | "so3-virt64-bench";
  so3_commit?: string | null;
  bench_defconfig_sha256?: string;
  shell_sha256: string;
  corpus_index_sha256: string;
  runs: CorpusRun[];
  artifacts: Record<string, string>;
}

interface CountsCell {
  insns: number;
  loads: number;
  stores: number;
  load_bytes: number;
  store_bytes: number;
}

type CountsTable = Record<string, Record<string, CountsCell>>;

interface CountsRun {
  run_id: number;
  by_segment_stage: CountsTable;
  by_frame: Array<{ frame: number; by_segment_stage: CountsTable }>;
}

export interface CountsFile {
  plugin: string;
  version: number;
  arch: "arm" | "aarch64";
  marker_hits: number;
  marker_misses: number;
  by_run?: CountsRun[];
}

export interface SerialObservation {
  run_id: number;
  host: string;
  frames: number;
  drawlist: string;
  fb_rgba8: string;
  replay_mismatches: number;
}

interface SerialRecord {
  kind: string;
  [key: string]: unknown;
}

function usage(): never {
  console.error(
    "usage: bun harness/run-ref.ts --profile virt32-bench|virt64-bench --artifacts DIR --segmap FILE [--plugin FILE]\n" +
      "       [--out-dir DIR] [--runs 2] [--timeout 120] [--docker-image IMAGE] [--no-run]\n" +
      "  --no-run validates serial-<n>.txt and counts-<n>.json already present in --out-dir",
  );
  process.exit(2);
}

export function parseSerial(path: string): SerialObservation[] {
  const observations: SerialObservation[] = [];
  let current: { run_id: number; host: string; action?: SerialObservation } | null = null;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const at = raw.indexOf('{"kind"');
    if (at < 0) continue;
    let record: SerialRecord;
    try {
      record = JSON.parse(raw.slice(at).trim()) as SerialRecord;
    } catch {
      continue;
    }
    if (record.kind === "identity") {
      if (current !== null) throw new Error(`${path}: identity before run ${current.run_id} ended`);
      const runId = record.run_id;
      const host = record.host;
      if (!Number.isInteger(runId) || typeof host !== "string") {
        throw new Error(`${path}: identity has no numeric run_id/host`);
      }
      current = { run_id: runId as number, host };
    } else if (record.kind === "action") {
      if (current === null) throw new Error(`${path}: action without identity`);
      const hashes = record.hashes as { drawlist?: unknown; fb_rgba8?: unknown } | undefined;
      const metrics = record.metrics as { replay_mismatches?: unknown } | undefined;
      if (
        record.action !== "tape" ||
        record.iteration !== "first" ||
        record.settled !== true ||
        typeof record.settle_frames !== "number" ||
        typeof hashes?.drawlist !== "string" ||
        typeof hashes.fb_rgba8 !== "string" ||
        typeof metrics?.replay_mismatches !== "number"
      ) {
        throw new Error(`${path}: malformed action for run ${current.run_id}`);
      }
      current.action = {
        run_id: current.run_id,
        host: current.host,
        frames: record.settle_frames,
        drawlist: hashes.drawlist,
        fb_rgba8: hashes.fb_rgba8,
        replay_mismatches: metrics.replay_mismatches,
      };
    } else if (record.kind === "end") {
      if (current === null) continue;
      if (record.exit !== 0) throw new Error(`${path}: run ${current.run_id} exited ${String(record.exit)}`);
      if (!current.action) throw new Error(`${path}: run ${current.run_id} ended without an action`);
      observations.push(current.action);
      current = null;
    }
  }
  if (current !== null) throw new Error(`${path}: run ${current.run_id} did not finish`);
  return observations;
}

function withoutIdle(table: CountsTable): CountsTable {
  return Object.fromEntries(
    Object.entries(table)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([segment, stages]) => [
        segment,
        Object.fromEntries(
          Object.entries(stages)
            .filter(([stage]) => stage !== "idle")
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      ])
      .filter(([, stages]) => Object.keys(stages as object).length > 0),
  );
}

export function stableCounts(doc: CountsFile): unknown {
  return {
    arch: doc.arch,
    marker_hits: doc.marker_hits,
    marker_misses: doc.marker_misses,
    by_run: (doc.by_run ?? [])
      .map((entry) => ({
        run_id: entry.run_id,
        by_segment_stage: withoutIdle(entry.by_segment_stage),
        by_frame: entry.by_frame.map((frame) => ({
          frame: frame.frame,
          by_segment_stage: withoutIdle(frame.by_segment_stage),
        })),
      }))
      .sort((a, b) => a.run_id - b.run_id),
  };
}

export function validateOne(
  manifest: CorpusManifest,
  serialPath: string,
  countsPath: string,
): { observations: SerialObservation[]; counts: CountsFile } {
  const observations = parseSerial(serialPath);
  if (observations.length !== manifest.runs.length) {
    throw new Error(`${serialPath}: ${observations.length} completed runs, expected ${manifest.runs.length}`);
  }
  const expectedHost = manifest.profile.includes("virt32") ? "so3-virt32" : "so3-virt64";
  for (let i = 0; i < manifest.runs.length; i++) {
    const expected = manifest.runs[i];
    const actual = observations[i];
    if (actual.host !== expectedHost) throw new Error(`${serialPath}: run ${actual.run_id} host ${actual.host}, expected ${expectedHost}`);
    if (actual.run_id !== expected.run_id) {
      throw new Error(`${serialPath}: run ${i} id ${actual.run_id}, expected ${expected.run_id}`);
    }
    if (actual.frames !== expected.frames) {
      throw new Error(`${serialPath}: ${expected.file} used ${actual.frames} frames, expected ${expected.frames}`);
    }
    if (actual.replay_mismatches !== 0) {
      throw new Error(`${serialPath}: ${expected.file} has ${actual.replay_mismatches} replay mismatch(es)`);
    }
  }

  const counts = readJson<CountsFile>(countsPath);
  const expectedArch = manifest.profile.includes("virt32") ? "arm" : "aarch64";
  if (counts.plugin !== "pocketcount" || counts.version < 2 || counts.arch !== expectedArch) {
    throw new Error(`${countsPath}: need pocketcount v2 for ${expectedArch}`);
  }
  if (counts.marker_misses !== 0) throw new Error(`${countsPath}: ${counts.marker_misses} marker miss(es)`);
  const countIds = (counts.by_run ?? []).map((entry) => entry.run_id).sort((a, b) => a - b);
  const expectedIds = manifest.runs.map((entry) => entry.run_id).sort((a, b) => a - b);
  if (!isDeepStrictEqual(countIds, expectedIds)) {
    throw new Error(`${countsPath}: by_run ids ${countIds.join(",")}, expected ${expectedIds.join(",")}`);
  }
  return { observations, counts };
}

function dockerImageId(image: string): string | null {
  const result = run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function fileSha256(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function runReference(
  profile: "virt32-bench" | "virt64-bench",
  artifacts: string,
  plugin: string | null,
  segmap: string,
  outDir: string,
  image: string,
  timeout: number,
  index: number,
  expectedRuns: number,
): Promise<void> {
  const serialName = `serial-${index}.txt`;
  const countsName = `counts-${index}.json`;
  const serialPath = join(outDir, serialName);
  rmSync(serialPath, { force: true });
  rmSync(join(outDir, countsName), { force: true });
  const args = [
    "run", "--rm",
    "-v", `${ROOT}:/repo:ro`,
    "-v", `${artifacts}:/artifacts:ro`,
    "-v", `${outDir}:/out`,
    "-v", `${segmap}:/inputs/segmap.txt:ro`,
  ];
  if (plugin !== null) args.push("-v", `${plugin}:/inputs/libpocketcount.so:ro`);
  const pluginInContainer = plugin === null ? "/opt/pocketcount/libpocketcount.so" : "/inputs/libpocketcount.so";
  args.push(
    image,
    "/repo/ref/run-qemu.sh",
    "--profile", profile,
    "--artifacts", "/artifacts",
    "--serial", `/out/${serialName}`,
    "--timeout", String(timeout),
    "--plugin", `${pluginInContainer},segmap=/inputs/segmap.txt,out=/out/${countsName}`,
  );
  console.log(`${LABEL}: ${profile} run ${index}`);
  const child = Bun.spawn({ cmd: ["docker", ...args], cwd: ROOT, stdout: "inherit", stderr: "pipe" });
  const stderrPromise = new Response(child.stderr).text();
  let completed = false;
  let fatal: string | null = null;
  while (child.exitCode === null) {
    if (existsSync(serialPath)) {
      const serial = readFileSync(serialPath, "utf8");
      const ends = (serial.match(/\{"kind":"end","exit":0\}/g) ?? []).length;
      if (ends >= expectedRuns) {
        completed = true;
        await Bun.sleep(250);
        child.kill("SIGINT");
        break;
      }
      if (/kernel_panic|abort exception/.test(serial)) {
        fatal = serial.trim().split("\n").slice(-4).join("\n");
        child.kill("SIGINT");
        break;
      }
    }
    await Bun.sleep(250);
  }
  const exitCode = await child.exited;
  const stderr = (await stderrPromise).trim();
  if (fatal !== null) throw new Error(`${LABEL}: guest failed during run ${index}:\n${fatal}`);
  // SO3 intentionally returns to its shell; GNU timeout ends QEMU after the
  // workload. Completion is decided from JSONL/counts below, not exit 124.
  if (!completed && exitCode !== 0 && exitCode !== 124) {
    throw new Error(`${LABEL}: docker run ${index} failed (${exitCode}):\n${stderr}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) usage();
  const profile = args.flags.get("profile");
  if (profile !== "virt32-bench" && profile !== "virt64-bench") usage();
  const artifactsFlag = args.flags.get("artifacts");
  const pluginFlag = args.flags.get("plugin");
  const segmapFlag = args.flags.get("segmap");
  if (!artifactsFlag || !segmapFlag) usage();
  const artifacts = resolve(artifactsFlag);
  const plugin = pluginFlag ? resolve(pluginFlag) : null;
  const segmap = resolve(segmapFlag);
  for (const path of [artifacts, ...(plugin ? [plugin] : []), segmap, join(artifacts, "runs.json")]) {
    if (!existsSync(path)) throw new Error(`${LABEL}: missing ${path}`);
  }
  const manifest = readJson<CorpusManifest>(join(artifacts, "runs.json"));
  const expectedProfile = `so3-${profile}`;
  if (manifest.schema_version !== 1 || manifest.profile !== expectedProfile) {
    throw new Error(`${LABEL}: artifact profile ${manifest.profile}, expected ${expectedProfile}`);
  }
  for (const [name, expectedHash] of Object.entries(manifest.artifacts)) {
    if (basename(name) !== name) throw new Error(`${LABEL}: unsafe artifact name ${JSON.stringify(name)}`);
    const path = join(artifacts, name);
    if (!existsSync(path)) throw new Error(`${LABEL}: artifact manifest names missing ${path}`);
    const actualHash = await fileSha256(path);
    if (actualHash !== expectedHash) throw new Error(`${LABEL}: ${path} hash ${actualHash}, expected ${expectedHash}`);
  }
  const repetitions = Number(args.flags.get("runs") ?? 2);
  const timeout = Number(args.flags.get("timeout") ?? 120);
  if (!Number.isInteger(repetitions) || repetitions < 2 || !Number.isInteger(timeout) || timeout <= 0) usage();
  const outDir = resolve(args.flags.get("out-dir") ?? join(ROOT, "results/ref", profile));
  const image = args.flags.get("docker-image") ?? process.env.POCKET_REF_IMAGE ?? "pocketjs-bench-ref-qemu:10.0.11";
  ensureDir(outDir);

  if (!args.flags.has("no-run")) {
    for (let i = 1; i <= repetitions; i++) {
      await runReference(profile, artifacts, plugin, segmap, outDir, image, timeout, i, manifest.runs.length);
    }
  }

  const validated = [];
  for (let i = 1; i <= repetitions; i++) {
    validated.push(validateOne(manifest, join(outDir, `serial-${i}.txt`), join(outDir, `counts-${i}.json`)));
  }
  const firstCounts = stableCounts(validated[0].counts);
  for (let i = 1; i < validated.length; i++) {
    if (!isDeepStrictEqual(firstCounts, stableCounts(validated[i].counts))) {
      throw new Error(`${LABEL}: non-idle by_run counts differ between run 1 and run ${i + 1}`);
    }
    if (!isDeepStrictEqual(validated[0].observations, validated[i].observations)) {
      throw new Error(`${LABEL}: serial observations differ between run 1 and run ${i + 1}`);
    }
  }

  const summary = {
    schema_version: 1,
    generated: new Date().toISOString(),
    profile: manifest.profile,
    bench_commit: gitHead(ROOT),
    so3_commit: manifest.so3_commit ?? null,
    bench_defconfig_sha256: manifest.bench_defconfig_sha256 ?? null,
    shell_sha256: manifest.shell_sha256,
    corpus_index_sha256: manifest.corpus_index_sha256,
    artifacts: manifest.artifacts,
    docker_image: image,
    docker_image_id: dockerImageId(image),
    plugin_sha256: plugin ? sha256(new Uint8Array(readFileSync(plugin))) : null,
    plugin_source: plugin ?? "/opt/pocketcount/libpocketcount.so",
    segmap_sha256: sha256(new Uint8Array(readFileSync(segmap))),
    artifact_manifest: join(artifacts, "runs.json"),
    repetitions,
    deterministic_non_idle_counts: true,
    runs: manifest.runs.map((entry, index) => ({
      ...entry,
      ...validated[0].observations[index],
      counts_by_segment_stage: withoutIdle(
        validated[0].counts.by_run!.find((counts) => counts.run_id === entry.run_id)!.by_segment_stage,
      ),
    })),
    counts_files: Array.from({ length: repetitions }, (_, i) => basename(join(outDir, `counts-${i + 1}.json`))),
  };
  writeJson(join(outDir, "summary.json"), summary);
  console.log(`${LABEL}: ${manifest.runs.length} tape(s) × ${repetitions}, deterministic -> ${join(outDir, "summary.json")}`);
}

if (import.meta.main) await main();
