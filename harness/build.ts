// harness/build.ts — 把 cases/ 与主仓 apps/ 编成三框架 bundle，写 dist/bundles/index.json。
//
//   bun harness/build.ts                                   全部 case + 全部三变体 app
//   bun harness/build.ts --cases list-create,mount-static  只编这些 case（--cases none 跳过 case）
//   bun harness/build.ts --apps hero,stats                 只编这些 app（--apps all / --apps none）
//   bun harness/build.ts --frameworks solid,octane
//
// case 先复制到 vendor/pocketjs/.pocket-build/bench-cases/<id>/（submodule 的 .gitignore 忽略），
// 再对副本调用 vendor/pocketjs/tools/build.ts，这样 `@pocketjs/framework/*`、`solid-js`、`vue`、
// `octane` 都解析到 submodule 自己的 node_modules——只能有一份 solid-js（docs/PROTOCOL.md）。
// 构建串行：tools/build.ts 每次都重写 framework/src/styles.generated.ts。

import { copyFileSync, cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  APPS,
  BUNDLES,
  BUNDLE_INDEX,
  CASES,
  DIST,
  FRAMEWORKS,
  STAGING,
  THREE_VARIANT_APPS,
  VENDOR,
  type AppTape,
  type BundleEntry,
  type BundleIndex,
  type Framework,
  bundleName,
  ensureDir,
  flagList,
  fnv1a64,
  gitHead,
  listCases,
  mustRun,
  parseArgs,
  parseFramework,
  readAppTapes,
  readCaseManifest,
  sha256,
  wantsHelp,
  writeJson,
} from "./lib.ts";

const LABEL = "bench build";

function usage(): never {
  console.error(
    "usage: bun harness/build.ts [--cases a,b|none] [--apps hero,...|all|none] [--frameworks solid,vue-vapor,octane]\n" +
      "  builds every selected case (cases/<id>) and app (vendor/pocketjs/apps/<app>) for every selected\n" +
      "  framework into dist/bundles/<name>.<framework>.{js,pak} and writes dist/bundles/index.json",
  );
  process.exit(2);
}

interface Target {
  kind: "case" | "app";
  name: string;
  entry: string;
  caseDir: string | null;
}

function stageCase(id: string): string {
  const source = join(CASES, id);
  const target = join(STAGING, id);
  rmSync(target, { recursive: true, force: true });
  ensureDir(STAGING);
  cpSync(source, target, { recursive: true });
  return target;
}

function appEntry(app: string): string {
  for (const candidate of ["main.tsx", "main.ts", "app.tsx"]) {
    const path = join(APPS, app, candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(`${LABEL}: ${join(APPS, app)} has no main.tsx / app.tsx`);
}

function buildOne(target: Target, framework: Framework): { js: string; pak: string } {
  const outdir = join(DIST, "build", target.name, framework);
  rmSync(outdir, { recursive: true, force: true });
  ensureDir(outdir);
  mustRun(
    LABEL,
    process.execPath,
    [join(VENDOR, "tools/build.ts"), target.entry, `--framework=${framework}`, `--outdir=${outdir}`],
    VENDOR,
  );
  const built = readdirSync(outdir).filter((name) => name.endsWith(".js"));
  if (built.length !== 1) {
    throw new Error(`${LABEL}: expected exactly one .js in ${outdir}, found ${built.join(", ") || "none"}`);
  }
  const js = join(outdir, built[0]);
  const pak = js.replace(/\.js$/, ".pak");
  if (!existsSync(pak)) throw new Error(`${LABEL}: ${pak} is missing next to ${js}`);
  return { js, pak };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) usage();

  const frameworks: Framework[] = flagList(args, "frameworks").length > 0
    ? flagList(args, "frameworks").map((fw) => parseFramework(fw, "--frameworks"))
    : [...FRAMEWORKS];

  const caseFlag = args.flags.get("cases");
  const caseIds = caseFlag === "none" ? [] : caseFlag ? flagList(args, "cases") : listCases();
  const appFlag = args.flags.get("apps");
  const appNames: string[] =
    appFlag === "none" ? [] : appFlag === undefined || appFlag === "all" ? [...THREE_VARIANT_APPS] : flagList(args, "apps");

  const targets: Target[] = [];
  for (const id of caseIds) {
    const dir = join(CASES, id);
    if (!existsSync(join(dir, "case.json"))) throw new Error(`${LABEL}: ${dir}/case.json does not exist`);
    const manifest = readCaseManifest(dir);
    targets.push({ kind: "case", name: manifest.id, entry: join(stageCase(id), manifest.entry), caseDir: dir });
  }
  for (const app of appNames) targets.push({ kind: "app", name: app, entry: appEntry(app), caseDir: null });
  if (targets.length === 0) throw new Error(`${LABEL}: nothing to build (no cases in ${CASES}, no apps selected)`);

  const tapes = readAppTapes();
  ensureDir(BUNDLES);
  const entries: BundleEntry[] = [];
  for (const target of targets) {
    const manifest = target.caseDir ? readCaseManifest(target.caseDir) : null;
    const wanted = manifest ? frameworks.filter((fw) => manifest.frameworks.includes(fw)) : frameworks;
    for (const framework of wanted) {
      const name = bundleName(target.name, framework);
      console.log(`${LABEL}: ${name}`);
      const built = buildOne(target, framework);
      const js = join(BUNDLES, `${name}.js`);
      const pak = join(BUNDLES, `${name}.pak`);
      copyFileSync(built.js, js);
      copyFileSync(built.pak, pak);
      const jsBytes = new Uint8Array(await Bun.file(js).arrayBuffer());
      const pakBytes = new Uint8Array(await Bun.file(pak).arrayBuffer());
      const tape: AppTape | null = target.kind === "app" ? (tapes[target.name] ?? { frames: 90, input: "" }) : null;
      entries.push({
        bundle: name,
        name: target.name,
        framework,
        kind: target.kind,
        js,
        pak,
        js_bytes: statSync(js).size,
        pak_bytes: statSync(pak).size,
        js_fnv1a64: fnv1a64(jsBytes),
        pak_fnv1a64: fnv1a64(pakBytes),
        js_sha256: sha256(jsBytes),
        pak_sha256: sha256(pakBytes),
        case: manifest
          ? {
              id: manifest.id,
              family: manifest.family,
              track: manifest.track,
              scale: manifest.scale,
              frameworks: manifest.frameworks,
              entry: manifest.entry,
              actions: manifest.actions,
              warmup: manifest.warmup,
              max_settle: manifest.max_settle,
              description: manifest.description,
            }
          : null,
        tape,
      });
    }
  }

  const index: BundleIndex = {
    generated: new Date().toISOString(),
    pocketjs_commit: gitHead(VENDOR),
    bundles: entries,
  };
  writeJson(BUNDLE_INDEX, index);
  console.log(`${LABEL}: ${entries.length} bundle(s) -> ${BUNDLE_INDEX}`);
}

if (import.meta.main) await main();
