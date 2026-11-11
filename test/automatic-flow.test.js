"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { toBinaryResult } = require("../src/automatic-flow");

test("inconclusive evidence becomes a final block without granting a stale choice", () => {
  const original = { decision: "review", outcome: null, allowed: true,
    review: { choice: "Proceed" }, reviewPlan: { state: "decision-recorded" },
    approval: { decision: "allow" }, authorization: { installAllowed: true },
    report: { verdict: "review", findings: [{ category: "dynamic-code", reason: "review this evidence" }] } };
  const result = toBinaryResult(original);
  assert.equal(result.decision, "block");
  assert.equal(result.allowed, false);
  assert.equal(result.authorization.installAllowed, false);
  assert.equal(result.approval.decision, "block");
  assert.equal(result.report.verdict, "block");
  assert.ok(!("review" in result));
  assert.ok(!("reviewPlan" in result));
  assert.deepEqual(result.report.findings, original.report.findings);
  assert.match(result.resolution.explanation, /not a confirmed malware finding/);
  assert.equal(original.decision, "review");
  assert.equal(original.authorization.installAllowed, true);
});

test("missing checks retain their coverage state and automatic retry facts", () => {
  const result = toBinaryResult({ decision: "review", assessment: {
    checks: { source: "completed", vulnerabilities: "failed" }, rawVerdict: "review" },
    resolution: { retry: { attempted: true, attempts: 1, check: "vulnerabilities" } } });
  assert.equal(result.assessment.checks.vulnerabilities, "failed");
  assert.equal(result.assessment.rawVerdict, "inconclusive");
  assert.equal(result.resolution.retry.attempts, 1);
  assert.deepEqual(result.resolution.reasonCodes, ["incomplete-checks"]);
});

test("known-safe and known-blocked results retain their decisions", () => {
  const result = toBinaryResult([{ verdict: "safe" }, { verdict: "block", findings: [] }]);
  assert.deepEqual(result, [{ verdict: "safe" }, { verdict: "block", findings: [] }]);
});

test("supplied evidence cannot be rewritten or treated as an approval", () => {
  const sourceFiles = { "package.json": { decision: "review", review: "literal source data" } };
  const result = toBinaryResult({ verdict: "safe", sourceFiles });
  assert.deepEqual(result.sourceFiles, sourceFiles);
  assert.notEqual(result.sourceFiles, sourceFiles);
  assert.equal(result.verdict, "safe");
});
