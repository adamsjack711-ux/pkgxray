'use strict';
// Shared transport and authorization checks for fixed observational cohorts.
const { start } = require('../test/helpers/mcp-load-client');
const { BUILD_ID } = require('../src/artifact');
const { receiptAuthorizes } = require('../src/approval-policy');
const { isDeepStrictEqual } = require('node:util');
const { performance } = require('node:perf_hooks');

const strings = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string'))];
function recordEvidence(entry, result) {
  if (!result || typeof result !== 'object') return;
  const assessment = result.assessment || {};
  entry.artifactSha256 = typeof result.resolved?.sha256 === 'string' ? result.resolved.sha256 : null;
  entry.buildId = typeof assessment.engine?.buildId === 'string' ? assessment.engine.buildId : null;
  entry.policySha256 = typeof assessment.policySha256 === 'string' ? assessment.policySha256 : null;
  entry.rawVerdict = assessment.rawVerdict ?? null;
  entry.reportVerdict = result.report?.verdict ?? result.verdict ?? null;
  entry.reasonCodes = strings(result.resolution?.reasonCodes);
  entry.mandatoryHoldReasons = strings(assessment.authorization?.mandatoryHoldReasons);
  entry.checks = structuredClone(assessment.checks || null);
  entry.sourceCoverage = structuredClone(result.sourceCoverage || null);
  entry.sourceComplete = result.sourceCoverage?.complete === true;
  entry.authorization = structuredClone(assessment.authorization || null);
  entry.explicitOverride = assessment.authorization?.explicitOverride ?? null;
  entry.retry = structuredClone(result.resolution?.retry || null);
  entry.vulnerabilityPrecheck = result.vulnerabilityPrecheck ? {
    enabled: result.vulnerabilityPrecheck.enabled,
    completed: result.vulnerabilityPrecheck.completed,
    vulnerabilityCount: result.vulnerabilityPrecheck.vulnerabilityCount
  } : null;
  entry.scanError = result.scanError === true;
  const findings = Array.isArray(result.report?.findings) ? result.report.findings : [];
  entry.categories = strings(findings.filter(f => f && ['medium', 'high'].includes(f.severity)).map(f => f.category));
  entry.informationalCategories = strings(findings.filter(f => f?.severity === 'info').map(f => f.category));
  entry.findingSeverityCounts = { high: 0, medium: 0, low: 0, info: 0, other: 0 };
  for (const finding of findings) {
    const severity = finding?.severity;
    entry.findingSeverityCounts[typeof severity === 'string' && Object.hasOwn(entry.findingSeverityCounts, severity) ? severity : 'other']++;
  }
}

function validateGuardResult(control, result, policies) {
  if (!result || !['allow', 'block'].includes(result.decision) || result.allowed !== (result.decision === 'allow')) return 'invalid-decision';
  if (result.resolved?.sha256 !== control.expectedSha256) return 'artifact-mismatch';
  if (result.assessment?.engine?.buildId !== BUILD_ID) return 'build-mismatch';
  const policy = result.assessment?.policySha256;
  if (typeof policy !== 'string' || !/^[a-f0-9]{64}$/.test(policy)) return 'invalid-policy-identity';
  policies.add(policy);
  if (result.allowed) {
    const receipt = result.approval;
    if (!receipt || receipt.artifactSha256 !== control.expectedSha256 ||
        result.assessment?.artifact?.sha256 !== control.expectedSha256 ||
        receipt.scannerBuildId !== BUILD_ID || receipt.policySha256 !== policy) return 'approval-identity-mismatch';
    // Keep this predicate identical for the original four controls and broader
    // cohorts. A receipt must agree with the public assessment and verdict.
    if (!receiptAuthorizes(receipt) || result.assessment.decision !== 'allow' ||
        result.report?.verdict !== 'safe' || !Array.isArray(result.report.findings) ||
        result.sourceCoverage?.complete !== receipt.sourceComplete ||
        !isDeepStrictEqual(result.assessment.checks, receipt.checks) ||
        !isDeepStrictEqual(result.assessment.authorization, receipt.authorization)) return 'invalid-allow-authorization';
  }
  return null;
}

async function runPinnedControls(controls, { createClient } = {}) {
  const cases = [], sessionErrors = [], policies = new Set();
  let client, ready = false;
  try {
    if (controls.some(control => control.acquisition?.status !== 'error')) {
      try { client = (createClient || (() => start()))(); await client.init(); ready = true; }
      catch { sessionErrors.push('initialization-failed'); }
    }
    for (const control of controls) {
      const entry = { packageName: control.packageName, version: control.version,
        expectedSha256: control.expectedSha256, status: 'error', scanAttempted: false, wallTimeMs: null };
      if (control.stratum) entry.stratum = control.stratum;
      if (control.acquisition) entry.acquisition = structuredClone(control.acquisition);
      cases.push(entry);
      if (control.acquisition?.status === 'error') { entry.error = 'acquisition-failed'; continue; }
      if (!ready) { entry.error = 'initialization-failed'; continue; }
      const began = performance.now();
      entry.scanAttempted = true;
      try {
        let response;
        try {
          response = await client.request('tools/call', { name: 'guard_agent_extension_install',
            arguments: { reference: `npm:${control.packageName}@${control.version}`, outputFormat: 'json' } });
        } catch { entry.error = 'request-failed'; continue; }
        const result = response?.result?.structuredContent;
        recordEvidence(entry, result);
        if (response?.error || response?.result?.isError) { entry.error = 'mcp-error'; continue; }
        if (result?.scanError) { entry.error = 'scan-failed'; continue; }
        const error = validateGuardResult(control, result, policies);
        if (error) { entry.error = error; continue; }
        entry.status = result.decision;
        entry.artifactSha256 = result.resolved.sha256;
        entry.buildId = result.assessment.engine.buildId;
        entry.policySha256 = result.assessment.policySha256;
        entry.allowAuthorizationValidated = result.allowed;
      } catch { entry.error = 'invalid-response'; }
      finally { entry.wallTimeMs = Number((performance.now() - began).toFixed(3)); }
    }
  } finally {
    if (client) { try { await client.close(); } catch { sessionErrors.push('cleanup-failed'); } }
  }
  if (policies.size > 1) sessionErrors.push('policy-changed');
  const counts = { allow: 0, block: 0, error: 0 };
  for (const entry of cases) counts[entry.status]++;
  const measurementValid = counts.error === 0 && sessionErrors.length === 0;
  return { measuredAt: new Date().toISOString(), scannerBuildId: BUILD_ID,
    transport: createClient ? 'injected test client' : 'real stdio MCP', realNetwork: !createClient, packageExecution: false,
    timing: 'Per-case request wall time in milliseconds, including registry/OSV network and MCP processing; excludes manifest acquisition and session initialization. Null means no request. Descriptive observations, not a latency benchmark.',
    cases, counts, sessionErrors, measurementValid, allControlsAllowed: measurementValid && counts.allow === controls.length };
}
module.exports = { runPinnedControls, validateGuardResult };
