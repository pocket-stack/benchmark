import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, FRAMEWORKS, listCases, readCaseManifest } from "../harness/lib.ts";

const EXPECTED = {
  animation: {
    family: "animation", scale: 24, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["start", "back"], warmup: 1, max_settle: 60,
  },
  "deep-tree": {
    family: "mount", scale: 48, frameworks: ["solid", "vue-vapor"],
    actions: ["noop"], warmup: 1, max_settle: 120,
  },
  "list-create": {
    family: "list", scale: 1000, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["create", "clear"], warmup: 1, max_settle: 120,
  },
  "list-ops": {
    family: "list", scale: 1000, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["append", "insert-middle", "update-every-10th", "swap", "reverse", "remove", "clear"],
    warmup: 1, max_settle: 120,
  },
  "mount-static": {
    family: "mount", scale: 200, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["noop"], warmup: 1, max_settle: 120,
  },
  "reactive-diamond": {
    family: "reactive", scale: 32, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["set", "set-back"], warmup: 1, max_settle: 120,
  },
  "reactive-fanin": {
    family: "reactive", scale: 100, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["set-one", "set-all", "set-back"], warmup: 1, max_settle: 120,
  },
  "reactive-fanout": {
    family: "reactive", scale: 100, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["set", "set-back"], warmup: 1, max_settle: 120,
  },
  "reactive-single": {
    family: "reactive", scale: 1, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["set", "same-value", "set-back"], warmup: 1, max_settle: 120,
  },
  "soak-churn": {
    family: "soak", scale: 200, frameworks: ["solid", "vue-vapor", "octane"],
    actions: ["churn"], warmup: 0, max_settle: 1300,
  },
} as const;

const caseIds = listCases();

function sourceActions(source: string): string[] {
  const list = /\bactions\s*:\s*\[([^\]]*)\]/.exec(source);
  if (!list) return [];
  return [...list[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("case manifests", () => {
  test("the canonical workload inventory is explicit", () => {
    expect(caseIds).toEqual(Object.keys(EXPECTED));
  });

  for (const id of caseIds) {
    test(`${id} pins its workload and every declared implementation`, () => {
      const dir = join(CASES, id);
      const manifest = readCaseManifest(dir);
      const expected = EXPECTED[id as keyof typeof EXPECTED];

      expect(manifest.id).toBe(id);
      expect(manifest.track).toBe("canonical");
      expect(manifest.entry).toBe("main.tsx");
      expect({
        family: manifest.family,
        scale: manifest.scale,
        frameworks: manifest.frameworks,
        actions: manifest.actions,
        warmup: manifest.warmup,
        max_settle: manifest.max_settle,
      }).toEqual(expected);

      for (const framework of FRAMEWORKS) {
        const suffix = framework === "solid" ? "" : "." + framework;
        const appPath = join(dir, "app" + suffix + ".tsx");
        const entryPath = join(dir, framework === "octane" ? "main.octane.tsx" : manifest.entry);
        const participates = manifest.frameworks.includes(framework);
        expect(existsSync(appPath)).toBe(participates);
        if (framework === "octane") expect(existsSync(entryPath)).toBe(participates);
        if (!participates) continue;
        expect(existsSync(entryPath)).toBe(true);
        const source = readFileSync(appPath, "utf8");
        expect(/\bversion\s*:\s*1\b/.test(source)).toBe(true);
        expect(/\bcase\s*:\s*["']([^"']+)["']/.exec(source)?.[1]).toBe(id);
        expect(sourceActions(source)).toEqual(manifest.actions);
      }
    });
  }
});
