'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runLiveControls } = require('../scripts/check-live-controls');
const { BENIGN_CONTROLS } = require('../scripts/validate-external-corpus');
const { BUILD_ID } = require('../src/artifact');
function fixture(change = () => {}) {
  const calls = [];
  let closed = 0;
  return { calls, get closed() { return closed; }, createClient: () => ({
    async init() {},
    async request(method, params) {
      calls.push({ method, params });
      const control = BENIGN_CONTROLS[calls.length - 1];
      const checks = { source: 'completed', vulnerabilities: 'completed', directDependencies: 'not-requested', provenance: 'not-requested' };
      const authorization = { behavioralCoverage: 'completed', mandatoryHoldReasons: [], explicitOverride: false };
      const result = { decision: 'allow', allowed: true, resolved: { sha256: control.artifactSha256 },
        assessment: { engine: { buildId: BUILD_ID }, artifact: { sha256: control.artifactSha256 },
          policySha256: 'a'.repeat(64), decision: 'allow', checks: structuredClone(checks), authorization: structuredClone(authorization) },
        sourceCoverage: { complete: true }, report: { verdict: 'safe', findings: [] },
        approval: { schemaVersion: 2, artifactSha256: control.artifactSha256, scannerBuildId: BUILD_ID,
          policySha256: 'a'.repeat(64), decision: 'allow', sourceComplete: true, checks, authorization } };
      change(result, calls.length);
      return { result: { structuredContent: result } };
    },
    async close() { closed++; }
  }) };
}

test('fixed live controls retain every identity and never disable required checks', async () => {
  const f = fixture();
  const result = await runLiveControls({ createClient: f.createClient });
  assert.equal(result.measurementValid, true);
  assert.equal(result.allControlsAllowed, true);
  assert.deepEqual(result.counts, { allow: 4, block: 0, error: 0 });
  assert.equal(f.closed, 1);
  assert.deepEqual(f.calls.map(call => call.params.arguments), BENIGN_CONTROLS.map(c => ({ reference: `npm:${c.packageName}@${c.version}`, outputFormat: 'json' })));
  assert.ok(f.calls.every(call => call.method === 'tools/call' && call.params.name === 'guard_agent_extension_install'));
});

test('a valid block remains visible and is not represented as all controls passing', async () => {
  const f = fixture((r, n) => { if (n === 4) { r.decision = 'block'; r.allowed = false; r.report.findings.push({ severity: 'medium', category: 'flow-analysis-gap' }); } });
  const result = await runLiveControls({ createClient: f.createClient });
  assert.equal(result.measurementValid, true);
  assert.equal(result.allControlsAllowed, false);
  assert.deepEqual(result.counts, { allow: 3, block: 1, error: 0 });
  assert.deepEqual(result.cases[3].categories, ['flow-analysis-gap']);
});

test('identity, build, malformed verdicts and incomplete allows cannot count as successes', async () => {
  for (const change of [
    r => { r.resolved.sha256 = 'b'.repeat(64); },
    r => { r.assessment.engine.buildId = 'b'.repeat(64); },
    r => { r.decision = 'review'; },
    r => { r.allowed = false; },
    r => { r.assessment.checks.source = 'partial'; },
    r => { r.assessment.checks.vulnerabilities = 'disabled'; },
    r => { r.sourceCoverage.complete = false; },
    r => { delete r.assessment.policySha256; }
  ]) {
    const f = fixture((r, n) => { if (n === 1) change(r); });
    const result = await runLiveControls({ createClient: f.createClient });
    assert.equal(result.measurementValid, false);
    assert.equal(result.allControlsAllowed, false);
    assert.deepEqual(result.counts, { allow: 3, block: 0, error: 1 });
    assert.equal(result.cases.length, 4, 'no replacement or omitted failure');
    assert.equal(f.closed, 1);
  }
});

test('policy drift prevents a cohort-wide success claim', async () => {
  const f = fixture((r, n) => { if (n === 4) r.assessment.policySha256 = 'b'.repeat(64); });
  const result = await runLiveControls({ createClient: f.createClient });
  assert.equal(result.measurementValid, false);
  assert.equal(result.allControlsAllowed, false);
  assert.ok(result.sessionErrors.includes('policy-changed'));
});

test('request failures preserve the selected case and cleanup without echoing raw errors', async () => {
  const f = fixture((r, n) => { if (n === 2) throw Error('sensitive raw transport details'); });
  const result = await runLiveControls({ createClient: f.createClient });
  assert.equal(result.counts.error, 1);
  assert.equal(result.cases[1].packageName, BENIGN_CONTROLS[1].packageName);
  assert.doesNotMatch(JSON.stringify(result), /sensitive raw/);
  assert.equal(f.closed, 1);
});

test('initialization failure accounts for every selected control and closes the client', async () => {
  let closed = false;
  const result = await runLiveControls({ createClient: () => ({
    async init() { throw Error('unavailable'); }, async close() { closed = true; }
  }) });
  assert.equal(closed, true);
  assert.deepEqual(result.counts, { allow: 0, block: 0, error: 4 });
  assert.equal(result.measurementValid, false);
});

test('actual authorization and receipt failures cannot become all controls allowed', async () => {
  for (const change of [
    r => { r.assessment.authorization.behavioralCoverage = 'partial'; r.assessment.authorization.mandatoryHoldReasons = ['unsupported-behavior']; },
    r => { r.assessment.checks.directDependencies = 'failed'; },
    r => { r.assessment.checks.provenance = 'invalid'; },
    r => { delete r.assessment.authorization; },
    r => { r.approval.authorization.behavioralCoverage = 'partial'; },
    r => { r.approval.authorization.mandatoryHoldReasons = ['flow-analysis-gap']; },
    r => { r.approval.authorization.explicitOverride = 'yes'; },
    r => { delete r.approval; },
    r => { r.approval.schemaVersion = 1; },
    r => { r.approval.checks.vulnerabilities = 'failed'; },
    r => { r.approval.checks.directDependencies = 'partial'; },
    r => { r.approval.checks.provenance = 'invalid'; },
    r => { r.approval.sourceComplete = false; },
    r => { r.approval.decision = 'block'; },
    r => { r.assessment.decision = 'block'; },
    r => { r.approval.artifactSha256 = 'b'.repeat(64); },
    r => { r.assessment.artifact.sha256 = 'b'.repeat(64); },
    r => { r.approval.scannerBuildId = 'b'.repeat(64); },
    r => { r.approval.policySha256 = 'b'.repeat(64); },
    r => { r.approval.authorization.explicitOverride = true; },
    r => { r.report.verdict = 'block'; },
    r => { delete r.report; }
  ]) {
    const f = fixture((r, n) => { if (n === 1) change(r); });
    const result = await runLiveControls({ createClient: f.createClient });
    assert.equal(result.allControlsAllowed, false, change.toString());
    assert.equal(result.measurementValid, false, change.toString());
    assert.deepEqual(result.counts, { allow: 3, block: 0, error: 1 });
    assert.equal(result.cases.length, 4); assert.equal(f.closed, 1);
  }
});

test('valid explicit overrides remain visible and do not bypass mandatory checks', async () => {
  const f = fixture(r => { r.approval.authorization.explicitOverride = true; r.assessment.authorization.explicitOverride = true; });
  const result = await runLiveControls({ createClient: f.createClient });
  assert.equal(result.measurementValid, true);
  assert.equal(result.allControlsAllowed, true);
  assert.ok(result.cases.every(c => c.authorization.behavioralCoverage === 'completed' && c.explicitOverride === true));
  const held = fixture(r => {
    r.approval.authorization.explicitOverride = true; r.assessment.authorization.explicitOverride = true;
    r.approval.authorization.mandatoryHoldReasons = ['unsupported-behavior'];
    r.assessment.authorization.mandatoryHoldReasons = ['unsupported-behavior'];
  });
  const stopped = await runLiveControls({ createClient: held.createClient });
  assert.equal(stopped.allControlsAllowed, false); assert.equal(stopped.counts.error, 4);
});
