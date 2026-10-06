"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { evaluateCase, summarizeResults, assessCoverage } = require("../benchmark/run");

function result(expect, actual, overrides = {}) {
  return evaluateCase({ fixture: "synthetic-outcome", corpus: expect === "block" ? "malicious" : "benign",
    expect, ...overrides }, { verdict: actual, findings: [] });
}

test("documented false blocks affect precision and raw totals, but not the regression gate", () => {
  const rows = [result("block", "block"), result("safe", "block", { knownFalsePositive: true }),
    result("review", "block")];
  const s = summarizeResults(rows);
  assert.equal(s.falseBlocks, 2);
  assert.equal(s.exemptedFalseBlocks, 1);
  assert.equal(s.gatingFalseBlocks, 1);
  assert.equal(s.knownFalsePositives, 1);
  assert.equal(s.blockPrecision, 0.333);
  assert.equal(s.blockRecall, 1);
  assert.equal(s.blockF1, 0.5);
  assert.deepEqual(s.blockMetricCounts, { truePositives: 1, falsePositives: 2, falseNegatives: 0,
    precisionDenominator: 3, recallDenominator: 1 });
  assert.equal(rows[1].rawOutcome, "FALSE_BLOCK");
  assert.equal(rows[1].outcome, "XFAIL");
  assert.equal(rows[2].outcome, "FALSE_BLOCK");
});

test("a malicious case cannot use the benign false-positive exemption", () => {
  for (const actual of ["safe", "review", "block"]) {
    assert.throws(() => result("block", actual, { knownFalsePositive: true }), /benign safe\/review/);
  }
  assert.throws(() => result("safe", "block", { corpus: "malicious", knownFalsePositive: true }), /benign safe\/review/);
  assert.throws(() => result("block", "safe", { corpus: "benign", knownFalsePositive: true }), /benign safe\/review/);
});

test("recall regressions, known underflags, full misses, and corrected benign exemptions retain gate behavior", () => {
  assert.equal(result("block", "review").outcome, "RECALL_DROP");
  assert.equal(result("block", "review", { knownUnderflag: true }).outcome, "UNDER_FLAG");
  assert.equal(result("block", "safe", { knownUnderflag: true }).outcome, "MISS");
  const corrected = result("safe", "safe", { knownFalsePositive: true });
  assert.equal(corrected.outcome, "CORRECT");
  assert.equal(corrected.xpass, true);
  assert.equal(corrected.xfail, false);
});

test("empty denominators produce null and zero detection remains zero when measurable", () => {
  const empty = summarizeResults([]);
  for (const key of ["blockPrecision", "blockRecall", "blockF1", "reviewRate", "benignReviewRate"]) {
    assert.equal(empty[key], null);
  }
  const missed = summarizeResults([result("block", "safe")]);
  assert.equal(missed.blockRecall, 0);
  assert.equal(missed.blockPrecision, null);
  assert.equal(missed.blockF1, null);
  const wrong = summarizeResults([result("block", "safe"), result("safe", "block")]);
  assert.equal(wrong.blockPrecision, 0);
  assert.equal(wrong.blockRecall, 0);
  assert.equal(wrong.blockF1, 0);
});

test("review rates state evaluated and benign denominators independently of expected verdicts", () => {
  const s = summarizeResults([result("block", "review", { knownUnderflag: true }),
    result("safe", "review", { knownFalsePositive: true }), result("review", "review"), result("safe", "safe")]);
  assert.equal(s.reviewCount, 3);
  assert.equal(s.reviewRateDenominator, 4);
  assert.equal(s.reviewRate, 0.75);
  assert.equal(s.benignReviewCount, 2);
  assert.equal(s.benignReviewRateDenominator, 3);
  assert.equal(s.benignReviewRate, 0.667);
  assert.equal(s.falseBlocks, 0);
});

const runner = path.resolve(__dirname, "../benchmark/run.js");
function cli(args) {
  const r = spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 30000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}

test("current MCP cohort reports its one benign fixture and unmeasured detection metrics", () => {
  const report = JSON.parse(cli(["--cohort", "mcp", "--json"]));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.malicious, 0);
  assert.equal(report.summary.benign, 1);
  for (const key of ["blockPrecision", "blockRecall", "blockF1"]) assert.equal(report.summary[key], null);
  assert.equal(report.summary.blockMetricCounts.recallDenominator, 0);
  assert.equal(report.summary.reviewRateDenominator, 1);
  assert.equal(report.metadata.scope, "committed-static-fixtures");
  assert.equal(report.metadata.livePackagesScanned, 0);
  assert.equal(report.metadata.representsPopulationAccuracy, false);
  assert.equal(report.cohorts.mcp.blockRecall, null);
  assert.deepEqual(report.coverage.cohorts.mcp.missingClasses, ["malicious"]);
  assert.equal(report.coverage.retentionGatePassed, true);
  assert.match(report.coverage.warnings.join("\n"), /detection recall is not measured/);
  const human = cli(["--cohort", "mcp"]);
  assert.match(human, /block recall\s*: N\/A \(not measured\)/);
  assert.match(human, /block precision\s*: N\/A \(not measured\)/);
  assert.match(human, /block F1\s*: N\/A \(not measured\)/);
});

test("full calibration reports separate cohort totals and a common review denominator", () => {
  const report = JSON.parse(cli(["--json"]));
  assert.deepEqual(Object.keys(report.cohorts), ["mcp", "npm", "pypi"]);
  for (const field of ["total", "malicious", "benign", "falseBlocks", "reviewCount", "reviewRateDenominator"]) {
    assert.equal(Object.values(report.cohorts).reduce((sum, cohort) => sum + cohort[field], 0), report.summary[field]);
  }
  assert.equal(report.summary.blockRecallFloor, 23);
  assert.equal(report.summary.recallFloorMet, true);
  assert.deepEqual(report.hardFailures, []);
  assert.equal(report.coverage.retentionGatePassed, true);
  assert.match(report.coverage.cohorts.pypi.limitation, /not general Python/);
});

function retainedRows() {
  return [
    ...Array.from({ length: 25 }, (_, i) => result("block", i ? "block" : "review", { cohort: "npm", knownUnderflag: true })),
    ...Array.from({ length: 32 }, () => result("safe", "safe", { cohort: "npm" })),
    ...Array.from({ length: 5 }, () => result("block", "block", { cohort: "pypi" })),
    ...Array.from({ length: 7 }, () => result("safe", "safe", { cohort: "pypi" })),
    result("review", "review", { cohort: "mcp" })
  ];
}

test("cohort retention catches deleting PyPI even though npm exceeds the global recall floor", () => {
  const rows = retainedRows();
  assert.deepEqual(assessCoverage(rows).failures, []);
  const withoutPypi = rows.filter((r) => r.cohort !== "pypi");
  assert.equal(summarizeResults(withoutPypi).maliciousBlocking, 24);
  const coverage = assessCoverage(withoutPypi);
  assert.equal(coverage.cohorts.pypi.retentionMet, false);
  assert.equal(coverage.failures.length, 3);
  assert.ok(coverage.failures.every((r) => r.outcome === "COVERAGE_DROP"));
  assert.deepEqual(coverage.cohorts.pypi.missingClasses, ["malicious", "benign"]);
});

test("cohort retention protects benign evidence and blocks independently", () => {
  const rows = retainedRows();
  assert.equal(assessCoverage(rows.filter((r) => r.cohort !== "mcp")).cohorts.mcp.retentionMet, false);
  const pypiIndex = rows.findIndex((r) => r.cohort === "pypi" && r.expect === "block");
  rows[pypiIndex] = result("block", "review", { cohort: "pypi", knownUnderflag: true });
  const coverage = assessCoverage(rows);
  assert.equal(coverage.cohorts.pypi.counts.malicious, 5);
  assert.equal(coverage.cohorts.pypi.retentionMet, false);
  assert.equal(coverage.failures.length, 1);
  assert.match(coverage.failures[0].fixture, /pypi blocking retention/);
});

test("filtered retention checks only the requested cohort", () => {
  const mcp = [result("review", "review", { cohort: "mcp" })];
  const coverage = assessCoverage(mcp, "mcp");
  assert.deepEqual(Object.keys(coverage.cohorts), ["mcp"]);
  assert.deepEqual(coverage.failures, []);
  assert.deepEqual(coverage.cohorts.mcp.missingClasses, ["malicious"]);
  for (const args of [["--cohort", "missing"], ["--cohort"], ["--cohort", "--json"]]) {
    const run = spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 30000 });
    assert.ifError(run.error);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no corpus cases|requires a cohort name/);
  }
});
