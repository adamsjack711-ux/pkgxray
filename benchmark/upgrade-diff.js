#!/usr/bin/env node
"use strict";

const { auditEvidence } = require("../src/auditor");
const { compareUpgradeFindings } = require("../src/upgrade-diff");
const corpus = require("./upgrade-corpus.json");

// A synthetic context for comparing reports made by the same in-process
// engine. This is not a guard receipt and does not claim network/CVE coverage.
function fixtureOutcome(evidence) {
  const report = auditEvidence(evidence);
  return { verdict: report.verdict, report, assessment: {
    engine: { buildId: "synthetic-fixture-engine" }, policySha256: "synthetic-fixture-policy",
    checks: { source: "completed", vulnerabilities: "completed" }
  } };
}

function signalCategories(findings) {
  return [...new Set((findings || []).filter(finding => ["medium", "high"].includes(finding.severity))
    .map(finding => finding.category))].sort();
}

function run() {
  const results = corpus.cases.map(fixture => {
    const delta = compareUpgradeFindings(fixtureOutcome(fixture.before), fixtureOutcome(fixture.after));
    const added = signalCategories(delta.added), notObserved = signalCategories(delta.notObserved);
    const missed = fixture.added.filter(category => !added.includes(category));
    const unexpected = added.filter(category => !fixture.added.includes(category));
    const absenceMismatch = JSON.stringify([...fixture.notObserved].sort()) !== JSON.stringify(notObserved);
    return { name: fixture.name, label: fixture.label, added, notObserved, missed, unexpected,
      passed: !missed.length && !unexpected.length && !absenceMismatch && delta.status === "compared" };
  });
  return {
    schemaVersion: 1, labelSource: corpus.labelSource, total: results.length,
    passed: results.filter(result => result.passed).length,
    missedAddedSignals: results.reduce((sum, result) => sum + result.missed.length, 0),
    unexpectedAddedSignals: results.reduce((sum, result) => sum + result.unexpected.length, 0),
    results
  };
}

if (require.main === module) {
  const result = run();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.passed === result.total ? 0 : 1;
}

module.exports = { run };
