"use strict";

// Shared by guard and every receipt consumer. A review policy is not an
// authorization to ignore checks that could not establish behavioral coverage.
const MANDATORY_CATEGORIES = Object.freeze([
  "incomplete-source-scan", "incomplete-dependency-scan", "unsupported-behavior",
  "flow-analysis-gap", "unresolved-runtime-execution"
]);
function authorizationFor(report, { sourceCoverage, dependencyAudit } = {}) {
  const reasons = new Set((report.findings || []).map(f => f.category)
    .filter(category => MANDATORY_CATEGORIES.includes(category)));
  if (sourceCoverage?.complete === false) reasons.add("incomplete-source-scan");
  if (dependencyAudit && (dependencyAudit.complete === false || dependencyAudit.error)) reasons.add("incomplete-dependency-scan");
  return {
    mandatoryHoldReasons: [...reasons].sort(),
    behavioralCoverage: reasons.size ? "partial" : "completed",
    explicitOverride: Boolean(report.configEffects?.allowlisted)
  };
}
function receiptAuthorizes(receipt, { allowReview = false } = {}) {
  const a = receipt?.authorization;
  if (receipt?.schemaVersion !== 2 || !a || !Array.isArray(a.mandatoryHoldReasons) ||
      a.mandatoryHoldReasons.some(r => typeof r !== "string" || !r) || typeof a.explicitOverride !== "boolean" ||
      !["completed", "partial"].includes(a.behavioralCoverage) ||
      receipt.sourceComplete !== true || receipt.checks?.source !== "completed" ||
      receipt.checks?.vulnerabilities !== "completed") return false;
  if (receipt.decision !== "allow" && !(allowReview && receipt.decision === "review")) return false;
  if (a.mandatoryHoldReasons.length || a.behavioralCoverage !== "completed") {
    return a.explicitOverride && receipt.decision === "allow";
  }
  return true;
}
module.exports = { MANDATORY_CATEGORIES, authorizationFor, receiptAuthorizes };
