import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostResult, hostRun } from "./fixtures/results.ts";
import { renderReport } from "./report.ts";

test("report renders successful host rows", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-report-"));
  const host = join(root, "host");
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, "list-create.solid.measure.json"), JSON.stringify(hostRun([hostResult("create", 1000, 3000)])));

  const report = renderReport(root);
  expect(report).toContain("| list-create.solid.measure | create | first | 2 |");
  expect(report).toContain("| 1000 | 3000 | 1000 | ok |");
  expect(report).not.toContain("No host results");
});

test("report keeps bundle failures visible without requiring successful results", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-report-"));
  const host = join(root, "host");
  mkdirSync(host, { recursive: true });
  writeFileSync(
    join(host, "failures.measure.json"),
    JSON.stringify({
      observer: "measure",
      failures: [
        {
          bundle: "gallery.octane",
          observer: "measure",
          exit_code: 2,
          stderr: "stack overflow\nsecond line",
          jsonl: "gallery.jsonl",
        },
      ],
    }),
  );

  const report = renderReport(root);
  expect(report).toContain("## Bundle failures");
  expect(report).toContain("| gallery.octane | measure | 2 | stack overflow |");
});
