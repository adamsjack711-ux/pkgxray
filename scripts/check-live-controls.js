'use strict';
// A fixed measurement cohort, not a production accuracy or performance estimate.
const { start } = require('../test/helpers/mcp-load-client');
const { BENIGN_CONTROLS } = require('./validate-external-corpus');
const { BUILD_ID } = require('../src/artifact');
const { receiptAuthorizes } = require('../src/approval-policy');
const { isDeepStrictEqual } = require('node:util');

async function runLiveControls({ createClient } = {}) {
  const injected = Boolean(createClient);
  const cases = [], sessionErrors = [], policies = new Set();
  let client, ready = false;
  try {
    try { client = (createClient || (() => start()))(); await client.init(); ready = true; }
    catch { sessionErrors.push('initialization-failed'); }
    for (const control of BENIGN_CONTROLS) {
      const entry = { packageName: control.packageName, version: control.version,
        expectedSha256: control.artifactSha256, status: 'error' };
      cases.push(entry);
      if (!ready) { entry.error = 'initialization-failed'; continue; }
      let result;
      try {
        const response = await client.request('tools/call', { name: 'guard_agent_extension_install',
          arguments: { reference: `npm:${control.packageName}@${control.version}`, outputFormat: 'json' } });
        if (response.error || response.result?.isError) { entry.error = 'mcp-error'; continue; }
        result = response.result?.structuredContent;
      } catch { entry.error = 'request-failed'; continue; }
      if (!result || !['allow', 'block'].includes(result.decision) || result.allowed !== (result.decision === 'allow')) {
        entry.error = 'invalid-decision'; continue;
      }
      if (result.resolved?.sha256 !== control.artifactSha256) { entry.error = 'artifact-mismatch'; continue; }
      if (result.assessment?.engine?.buildId !== BUILD_ID) { entry.error = 'build-mismatch'; continue; }
      const policy = result.assessment?.policySha256;
      if (typeof policy !== 'string' || !/^[a-f0-9]{64}$/.test(policy)) { entry.error = 'invalid-policy-identity'; continue; }
      policies.add(policy);
      const checks = result.assessment?.checks;
      if (result.allowed) {
        const receipt = result.approval;
        if (!receipt || receipt.artifactSha256 !== control.artifactSha256 ||
            result.assessment?.artifact?.sha256 !== control.artifactSha256 ||
            receipt.scannerBuildId !== BUILD_ID || receipt.policySha256 !== policy) {
          entry.error = 'approval-identity-mismatch'; continue;
        }
        // The canonical receipt predicate includes behavioral coverage,
        // dependency/provenance failures and mandatory holds. Independently
        // reject a receipt that contradicts the public assessment or verdict.
        if (!receiptAuthorizes(receipt) || result.assessment.decision !== 'allow' ||
            result.report?.verdict !== 'safe' || !Array.isArray(result.report.findings) ||
            result.sourceCoverage?.complete !== receipt.sourceComplete ||
            !isDeepStrictEqual(checks, receipt.checks) ||
            !isDeepStrictEqual(result.assessment.authorization, receipt.authorization)) {
          entry.error = 'invalid-allow-authorization'; continue;
        }
      }
      entry.status = result.decision;
      entry.artifactSha256 = result.resolved.sha256;
      entry.buildId = result.assessment.engine.buildId;
      entry.policySha256 = policy;
      entry.checks = checks;
      entry.sourceComplete = result.sourceCoverage?.complete === true;
      entry.authorization = result.assessment.authorization || null;
      entry.explicitOverride = result.assessment.authorization?.explicitOverride ?? null;
      const findings = Array.isArray(result.report?.findings) ? result.report.findings : [];
      entry.categories = [...new Set(findings.filter(f => f && ['medium', 'high'].includes(f.severity)).map(f => f.category))];
      entry.informationalCategories = [...new Set(findings.filter(f => f?.severity === 'info').map(f => f.category))];
    }
  } finally {
    if (client) { try { await client.close(); } catch { sessionErrors.push('cleanup-failed'); } }
  }
  if (policies.size > 1) sessionErrors.push('policy-changed');
  const counts = { allow: 0, block: 0, error: 0 };
  for (const entry of cases) counts[entry.status]++;
  const measurementValid = counts.error === 0 && sessionErrors.length === 0;
  return { measuredAt: new Date().toISOString(), scannerBuildId: BUILD_ID,
    transport: injected ? 'injected test client' : 'real stdio MCP', realNetwork: !injected, packageExecution: false,
    selection: 'Four fixed exact-version registry controls with pinned artifact SHA256; no replacement on errors.',
    limitations: 'Small selected benign cohort; labels are assumptions. Not production accuracy, malicious recall, or a latency benchmark. A valid measurement may contain blocks.',
    cases, counts, sessionErrors, measurementValid, allControlsAllowed: measurementValid && counts.allow === BENIGN_CONTROLS.length };
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    console.error('Usage: node scripts/check-live-controls.js --live (real npm/OSV checks; exits nonzero for invalid measurement, not for a valid block).');
    process.exitCode = 1;
  } else {
    runLiveControls().then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.measurementValid) process.exitCode = 1;
    }).catch(() => { console.error('Live control measurement failed.'); process.exitCode = 1; });
  }
}
module.exports = { runLiveControls };
