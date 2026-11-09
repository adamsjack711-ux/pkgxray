import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStats, renderMethodology, renderStatsPage } from "../stats/build.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, "stats/data");
const historicalRuns = readdirSync(DATA).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(DATA, name), "utf8")))
  .sort((a, b) => a.runId < b.runId ? 1 : -1);

// Captured from the published pages before this generator update. CSS cache
// keys are presentation metadata; all historical prose and numbers stay fixed.
const hashes = {
  "2026-07-19-retuned": "65b5ed2d09daa3a970ad0b11167b8b9e73c2f49aae478058ef0d30ffd9846eb1",
  "2026-07-19": "b4f017b38bc06125680f0704a37d86c4800272eb34e03b3d741f7f7490220e2a",
  "2026-07-21": "3f8c9aff8459407da34d76ebdac4b10e91e8ea015accf5e0ea9df73f2b663b62",
  "2026-08-04-pypi": "fc8b99eb730642b2a90eedd479dd2273f13f51347a0caa9f3ae1fa26db849881",
  "methodology-2026-08-04-pypi": "a4a5143f27a19e4d6fcae0d18237ed3849a6f684d277e74bd186c57caf1c3de3",
  methodology: "b8b203f94f303d48551ec86516aae1c9c217d2605b96e8333dbb9ee08d7b2351",
};
function digest(html) {
  return createHash("sha256").update(html.replace(/styles\.css\?v=[^"']+/g, "styles.css?v=CACHE")).digest("hex");
}

test("historical npm and PyPI pages retain their published content", () => {
  const flagship = historicalRuns.find((run) => (run.ecosystem || "npm") === "npm");
  for (const run of historicalRuns) {
    assert.equal(digest(renderStatsPage(run, { isLatest: run === flagship, allRuns: historicalRuns })), hashes[run.runId]);
  }
  assert.equal(digest(renderMethodology(flagship)), hashes.methodology);
  const pypi = historicalRuns.find((run) => run.ecosystem === "pypi");
  const slug = `methodology-${pypi.runId}`;
  assert.equal(digest(renderMethodology(pypi, slug)), hashes[slug]);
});

function validationRun(cohort) {
  return {
    runId: `2026-10-04-${cohort}`, runDate: "2026-10-04", cohort,
    pkgxray: { version: "1.1.0", commit: "test", node: "v22", command: "pkgxray guard npm:example@1.0.0" },
    headline: {
      packagesScanned: 9, packagesAttempted: 10, scanErrors: 1,
      topThousandFalseBlocks: { count: 0, of: 9, rate: 0, classification: "unadjudicated-heuristic-block-candidates" },
      knownMalwareCatchRate: { blocked: 0, of: 0, rate: null, passedAsSafe: 0 },
    },
    methodologyUrl: `/stats/2026-10-04-${cohort}-methodology`,
    reproInputs: "https://example.com/targets", corrections: { contact: "https://example.com/issues" },
  };
}

test("new cohort fields label candidates and unmeasured recall honestly", () => {
  for (const [cohort, label] of [["npm", "npm"], ["pypi", "PyPI"], ["mcp", "MCP"]]) {
    const run = validationRun(cohort);
    const html = renderStatsPage(run, { isLatest: false, allRuns: [run] });
    assert.match(html, /N\/A/);
    assert.match(html, /no malicious fixtures/i);
    assert.match(html, /heuristic block candidates/);
    assert.ok(html.includes(`${label} cohort, completed static scans`));
    assert.ok(html.includes(`href="./${run.runId}-methodology.html"`));
    assert.doesNotMatch(html, /href="\.\/methodology\.html"/);
    assert.doesNotMatch(html, /most-downloaded packages|false blocks, top 1,000|adjudicated\s+by hand/);
    const methodology = renderMethodology(run);
    assert.match(methodology, /9 scans completed out of 10 attempts/);
    assert.match(methodology, /1 attempts failed/);
    assert.match(methodology, /recall has not been measured/);
    assert.ok(methodology.includes(`href="https://pkgxray.ca${run.methodologyUrl}"`));
    assert.doesNotMatch(methodology, /href="\.\/methodology\.html"/);
    assert.doesNotMatch(methodology, /Every top-1000 block was a real CVE|every one was read by hand/);
  }
});

test("mixed publication retains the npm flagship, old PyPI methodology, and dated new links", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "pkgxray-site-stats-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const dataDir = join(temp, "data");
  const outputDir = join(temp, "output");
  mkdirSync(dataDir);
  mkdirSync(outputDir);
  for (const name of readdirSync(DATA)) copyFileSync(join(DATA, name), join(dataDir, name));
  for (const cohort of ["npm", "pypi", "mcp"]) {
    const run = validationRun(cohort);
    writeFileSync(join(dataDir, `${run.runId}.json`), JSON.stringify(run));
  }
  buildStats({ dataDir, outputDir });
  const index = readFileSync(join(outputDir, "index.html"), "utf8");
  assert.match(index, /rel="canonical" href="https:\/\/pkgxray.ca\/stats\/2026-07-21"/);
  assert.equal(digest(readFileSync(join(outputDir, "methodology.html"), "utf8")), hashes.methodology);
  assert.equal(digest(readFileSync(join(outputDir, "methodology-2026-08-04-pypi.html"), "utf8")), hashes["methodology-2026-08-04-pypi"]);
  for (const name of readdirSync(DATA)) {
    assert.deepEqual(readFileSync(join(outputDir, name)), readFileSync(join(DATA, name)), "archived JSON must be copied without changes");
  }
  for (const cohort of ["npm", "pypi", "mcp"]) {
    const run = validationRun(cohort);
    const html = readFileSync(join(outputDir, `${run.runId}.html`), "utf8");
    assert.ok(html.includes(`href="./${run.runId}-methodology.html"`));
    const methodology = readFileSync(join(outputDir, `${run.runId}-methodology.html`), "utf8");
    assert.ok(methodology.includes(`href="https://pkgxray.ca${run.methodologyUrl}"`));
  }
});
