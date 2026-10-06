"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("historical calibration pages regenerate consistently with their recorded artifacts", async () => {
  const { renderStatsPage, renderMethodology } = await import("../website/stats/build.mjs");
  const dir = path.join(__dirname, "../website/stats");
  const runs = fs.readdirSync(path.join(dir, "data"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, "data", name), "utf8")))
    .sort((a, b) => b.runId.localeCompare(a.runId));
  const flagship = runs.find((run) => (run.cohort || run.ecosystem || "npm") === "npm" &&
    run.headline.topThousandFalseBlocks.classification !== "unadjudicated-heuristic-block-candidates") || runs[0];
  for (const run of runs) {
    assert.equal(renderStatsPage(run, { isLatest: run === flagship, allRuns: runs }),
      fs.readFileSync(path.join(dir, `${run.runId}.html`), "utf8"));
  }
  assert.equal(renderMethodology(flagship), fs.readFileSync(path.join(dir, "methodology.html"), "utf8"));
});

test("new cohort pages distinguish unmeasured recall and unadjudicated blocks", async () => {
  const { renderStatsPage, renderMethodology } = await import("../website/stats/build.mjs");
  const run = cohortRun();
  const html = renderStatsPage(run, { isLatest: true, allRuns: [run] });
  assert.match(html, /N\/A/);
  assert.match(html, /no malicious fixtures/i);
  assert.match(html, /heuristic block candidates/);
  assert.match(html, /mcp cohort, completed static scans/i);
  assert.doesNotMatch(html, /most-downloaded packages|false blocks, top 1,000/);
  const methodology = renderMethodology(run);
  assert.match(methodology, /9 scans completed out of 10 attempts/);
  assert.match(methodology, /recall has not been measured/);
  assert.doesNotMatch(methodology, /Every top-1000 block was a real CVE|Each one was read by hand/);
});

function cohortRun() {
  return {
    runId: "2026-10-04-mcp", runDate: "2026-10-04", cohort: "mcp",
    pkgxray: { version: "1.1.0", commit: "test", node: "v22", command: "pkgxray guard npm:example@1.0.0" },
    headline: {
      packagesScanned: 9, packagesAttempted: 10, scanErrors: 1,
      topThousandFalseBlocks: { count: 0, of: 9, rate: 0, classification: "unadjudicated-heuristic-block-candidates" },
      knownMalwareCatchRate: { blocked: 0, of: 0, rate: null, passedAsSafe: 0 },
    },
    reproInputs: "https://example.com/targets", corrections: { contact: "https://example.com/issues" },
  };
}

test("publishing a new cohort preserves historical methodology links", (t) => {
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const original = path.join(__dirname, "../website/stats");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pkgxray-stats-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.copyFileSync(path.join(original, "build.mjs"), path.join(temp, "build.mjs"));
  fs.cpSync(path.join(original, "data"), path.join(temp, "data"), { recursive: true });
  const run = cohortRun();
  fs.writeFileSync(path.join(temp, "data", `${run.runId}.json`), JSON.stringify(run));
  const result = spawnSync(process.execPath, [path.join(temp, "build.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(temp, "methodology.html"), "utf8"),
    fs.readFileSync(path.join(original, "methodology.html"), "utf8"));
  const dated = fs.readFileSync(path.join(temp, `${run.runId}-methodology.html`), "utf8");
  assert.match(dated, /recall has not been measured/);
  const page = fs.readFileSync(path.join(temp, `${run.runId}.html`), "utf8");
  assert.ok(page.includes(`href="./${run.runId}-methodology.html"`));
});
