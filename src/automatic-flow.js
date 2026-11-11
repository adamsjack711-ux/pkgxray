"use strict";

// Presentation boundary for the automatic flow. The analyzer may retain its
// three-way evidence vocabulary internally; uncertainty never authorizes use.
// Findings and supplied source are evidence, not control-plane instructions.
const EVIDENCE_FIELDS = new Set(["findings", "sourceFiles", "sourceEvidence", "vulnerabilities", "configEffects", "manifest", "inputSchema", "outputSchema", "config", "policy", "npmMetadata"]);
const MANUAL_FIELDS = new Set(["review", "reviewPlan", "reviewId", "reviewChoice", "reviewScope", "reviewDecisions"]);
const DECISION_FIELDS = new Set(["verdict", "decision", "worstDecision", "worstRegression", "recommendation"]);
const UNCERTAIN = new Set(["review", "unknown", "incomplete"]);
const PERMISSION_FIELDS = ["allowed", "installAllowed", "executeAllowed", "promoteAllowed", "deliveryAllowed"];

function hasMissingChecks(value) {
  const checks = value.assessment?.checks || value.checks || {};
  return Object.entries(checks).some(([name, state]) =>
    ["failed", "partial"].includes(state) ||
    (["source", "vulnerabilities"].includes(name) && ["disabled", "skipped"].includes(state))) ||
    value.sourceCoverage?.complete === false ||
    ["partial", "incomplete", "failed"].includes(value.coverage?.status) ||
    ["partial", "incomplete", "failed"].includes(value.execution) ||
    (value.findings || value.report?.findings || []).some(f =>
      /^(?:incomplete-|scan-error|vulnerability-scan-error|missing-source)/.test(f.category || ""));
}

function denyPermissions(value) {
  for (const key of PERMISSION_FIELDS) if (key in value) value[key] = false;
  if (value.authorization && typeof value.authorization === "object") {
    for (const key of PERMISSION_FIELDS) if (key in value.authorization) value.authorization[key] = false;
  }
}

function toBinaryResult(value) {
  if (Array.isArray(value)) return value.map(toBinaryResult);
  if (!value || typeof value !== "object") return value;
  const uncertain = [...DECISION_FIELDS].some(key => UNCERTAIN.has(value[key])) ||
    UNCERTAIN.has(value.report?.verdict);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (MANUAL_FIELDS.has(key)) continue;
    if (EVIDENCE_FIELDS.has(key)) { result[key] = structuredClone(item); continue; }
    if (key === "schemaVersion" && item === 1) { result[key] = 2; continue; }
    if (DECISION_FIELDS.has(key) && UNCERTAIN.has(item)) { result[key] = "block"; continue; }
    if (key === "rawVerdict" && UNCERTAIN.has(item)) { result[key] = "inconclusive"; continue; }
    if (key === "baseline" && item === "review") { result[key] = "block"; continue; }
    if (key === "exitCode" && item === 3) { result[key] = 2; continue; }
    result[key] = toBinaryResult(item);
  }
  if (uncertain) {
    if ("decision" in result) result.decision = "block";
    if ("verdict" in result) result.verdict = "block";
    if ("outcome" in result) result.outcome = "UNSAFE";
    denyPermissions(result);
    if (result.approval) { result.approval.decision = "block"; denyPermissions(result.approval); }
    const reason = hasMissingChecks(value) || ["unknown", "incomplete"].includes(value.verdict) ? "incomplete-checks" : "uncertain-findings";
    result.resolution = {
      ...result.resolution,
      reasonCodes: [...new Set([...(result.resolution?.reasonCodes || []), reason])],
      explanation: reason === "incomplete-checks"
        ? "Blocked because required checks could not complete. This is not a confirmed malware finding."
        : "Blocked because the evidence remains inconclusive. This is not a confirmed malware finding."
    };
    // Replace scanner-authored legacy instructions; original finding evidence
    // remains untouched and cannot become a request for operator approval.
    if (typeof result.summary === "string") result.summary = result.resolution.explanation;
  }
  return result;
}

module.exports = { toBinaryResult };
