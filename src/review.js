"use strict";
const { fingerprint } = require("./artifact");

// Retained as an evidence identity helper for library compatibility. Identity
// is never authority: old session/local choices are not read or persisted.
function reviewIdentity(receipt, { action = "use", target = null } = {}) {
  if (!receipt?.artifactSha256 || !receipt.policySha256 || !receipt.scannerBuildId) return null;
  return fingerprint({ artifact: receipt.artifactSha256, policy: receipt.policySha256,
    action, target, analysis: receipt.analysisSha256 || null, evidence: receipt.evidenceSha256 || null,
    scanner: receipt.scannerBuildId, name: receipt.name, version: receipt.version });
}
function reviewOutcome(decision) {
  const allowed = decision === "allow" || decision === "safe";
  return { outcome: allowed ? "SAFE" : "UNSAFE", allowed, review: null };
}
function rejectManualReviewOptions(options = {}) {
  for (const key of ["reviewId", "reviewChoice", "reviewScope", "reviewDecisions", "reviewAction"]) {
    if (Object.hasOwn(options, key)) throw new Error("Manual REVIEW options have been removed; uncertainty is resolved automatically or blocked.");
  }
}
module.exports = { reviewIdentity, reviewOutcome, rejectManualReviewOptions };
