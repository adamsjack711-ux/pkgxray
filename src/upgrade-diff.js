"use strict";

const crypto = require("node:crypto");

const MAX_FINDINGS = 2000;
const MAX_FIELD = 16384;
const MAX_OUTPUT = 50;
const SEVERITIES = new Set(["high", "medium", "low", "info"]);

// This compares observations from two fresh scans, never stored approvals.
// Exact evidence text is part of identity; line numbers and rationale prose are
// not. A finding moving down a file is not new, but a different cited command
// in the same category is. Counts preserve duplicate observations.
function indexFindings(outcome) {
  const findings = outcome?.report?.findings;
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) return null;
  const index = new Map();
  for (const finding of findings) {
    if (!finding || !SEVERITIES.has(finding.severity)) return null;
    const fields = [finding.category, finding.severity, finding.file, finding.snippet];
    if (fields.some(field => typeof field !== "string" || field.length > MAX_FIELD)) return null;
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    const entry = index.get(fingerprint);
    if (entry) entry.count += 1;
    else index.set(fingerprint, {
      fingerprint, category: finding.category, severity: finding.severity,
      file: finding.file, count: 1
    });
  }
  return index;
}

function scanComplete(outcome) {
  const assessment = outcome?.assessment;
  const checks = assessment?.checks;
  return Boolean(checks && checks.source === "completed" && checks.vulnerabilities === "completed" &&
    !Object.values(checks).some(value => ["failed", "partial", "skipped"].includes(value)) &&
    typeof assessment.engine?.buildId === "string" && assessment.engine.buildId.length > 0 &&
    typeof assessment.policySha256 === "string" && assessment.policySha256.length > 0);
}

function difference(left, right) {
  const result = [];
  for (const [key, item] of left) {
    const count = item.count - (right.get(key)?.count || 0);
    if (count > 0) result.push({ ...item, count });
  }
  return result.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

function compareUpgradeFindings(baseline, candidate) {
  const before = indexFindings(baseline);
  const after = indexFindings(candidate);
  const limitations = [];
  if (!before) limitations.push("baseline-findings-unavailable");
  if (!after) limitations.push("candidate-findings-unavailable");
  if (!before || !after) return {
    schemaVersion: 1, status: "unavailable", limitations,
    added: [], notObserved: null, counts: null, truncated: false
  };
  if (!scanComplete(baseline)) limitations.push("baseline-scan-incomplete-or-unverified");
  if (!scanComplete(candidate)) limitations.push("candidate-scan-incomplete-or-unverified");
  if (baseline?.assessment?.engine?.buildId !== candidate?.assessment?.engine?.buildId) limitations.push("scanner-build-differs");
  if (baseline?.assessment?.policySha256 !== candidate?.assessment?.policySha256) limitations.push("policy-differs");
  const beforeChecks = baseline?.assessment?.checks || {};
  const afterChecks = candidate?.assessment?.checks || {};
  const keys = new Set([...Object.keys(beforeChecks), ...Object.keys(afterChecks)]);
  if ([...keys].some(key => beforeChecks[key] !== afterChecks[key])) limitations.push("check-coverage-differs");
  const added = difference(after, before);
  // Absence only has meaning with comparable completed scans. Even then call
  // it "not observed", never "resolved": scanner silence is not proof of a fix.
  const notObserved = limitations.length === 0 ? difference(before, after) : null;
  const count = entries => entries.reduce((sum, entry) => sum + entry.count, 0);
  return {
    schemaVersion: 1, status: limitations.length ? "partial" : "compared", limitations,
    added: added.slice(0, MAX_OUTPUT), notObserved: notObserved?.slice(0, MAX_OUTPUT) ?? null,
    counts: { added: count(added), notObserved: notObserved ? count(notObserved) : null },
    truncated: added.length > MAX_OUTPUT || Boolean(notObserved && notObserved.length > MAX_OUTPUT)
  };
}

module.exports = { compareUpgradeFindings };
