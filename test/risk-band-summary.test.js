"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { computeRiskBands, renderMarkdown } = require("../src/auditor");

function makeFindings(n) {
  return Array.from({ length: n }, (_, i) => ({
    severity: "medium",
    category: "install-hook",
    file: `hook-${i}.js`,
    rationale: "runs at install",
    snippet: "postinstall"
  }));
}

function renderBandLine(n) {
  const riskBands = computeRiskBands(makeFindings(n));
  assert.equal(riskBands.length, 1);
  assert.equal(riskBands[0].count, n);
  const markdown = renderMarkdown({
    verdict: "review",
    grade: "C",
    score: 75,
    summary: "test summary",
    riskBands,
    parameters: {},
    findings: []
  });
  const line = markdown.split("\n").find((l) => l.includes("lifecycle-script"));
  assert.ok(line, "band summary line rendered");
  return line;
}

// Regression: the summary used to render 2 examples but subtract the 3 stored
// ones when computing "+N more", so one finding per band silently vanished
// whenever count >= 3. Rendered examples + remainder must equal the count.
for (const n of [1, 2, 3, 4, 5]) {
  test(`band summary accounts for every finding (n=${n})`, () => {
    const line = renderBandLine(n);
    const rendered = (line.match(/`hook-\d+\.js`/g) || []).length;
    const moreMatch = line.match(/\+(\d+) more/);
    const remainder = moreMatch ? Number(moreMatch[1]) : 0;
    assert.equal(rendered, Math.min(n, 3), "renders every stored example");
    assert.equal(rendered + remainder, n, "rendered + remainder equals true count");
  });
}
