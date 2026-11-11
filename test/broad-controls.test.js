'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runBroadControls, validateManifest, COHORT_ID, STRATA } = require('../scripts/check-broad-controls');
const { BENIGN_CONTROLS } = require('../scripts/validate-external-corpus');
const { BUILD_ID } = require('../src/artifact');
const { SELECTED } = require('../scripts/acquire-broad-live-cohort');
function manifestFixture() {
  const cases = [];
  for (const selected of SELECTED) {
    const { packageName, stratum } = selected;
    const original = BENIGN_CONTROLS.find(control => control.packageName === packageName);
    const version = original?.version || '1.0.0';
    cases.push({ packageName, version, stratum, selection: original ? 'original-control' : 'latest-at-acquisition',
      reference: `${packageName}@${version}`, expectedSha256: original?.artifactSha256 || 'a'.repeat(64),
      sourceUrl: `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`,
      compressedBytes: 100, distIntegrity: `sha256-${Buffer.alloc(32).toString('base64')}`,
      acquisition: { status: 'verified', metadataAttempts: 1, tarballAttempts: 1 } });
  }
  return { schemaVersion: 1, cohortId: COHORT_ID, selectedCount: 32,
    selectionFrozenAt: '2026-11-11T00:00:00.000Z', acquiredAt: '2026-11-11T00:01:00.000Z', selection: 'Fixed test identities before measurement.',
    limits: { metadataBytes: 1048576, compressedBytes: 8388608, caseDeadlineMs: 30000, maxAttemptsPerResource: 2, concurrency: 4 }, cases };
}
function fixture(manifest, change = () => {}) {
  const calls = []; let closed = 0, initialized = 0;
  return { calls, get closed() { return closed; }, get initialized() { return initialized; }, createClient: () => ({
    async init() { initialized++; }, async close() { closed++; },
    async request(method, params) {
      calls.push({ method, params });
      const control = manifest.cases.find(c => `npm:${c.reference}` === params.arguments.reference);
      const checks = { source: 'completed', vulnerabilities: 'completed', directDependencies: 'not-requested', provenance: 'not-requested' };
      const authorization = { behavioralCoverage: 'completed', mandatoryHoldReasons: [], explicitOverride: false };
      const result = { decision: 'allow', allowed: true, resolved: { sha256: control.expectedSha256 },
        assessment: { engine: { buildId: BUILD_ID }, artifact: { sha256: control.expectedSha256 }, policySha256: 'b'.repeat(64),
          rawVerdict: 'safe', decision: 'allow', checks: structuredClone(checks), authorization: structuredClone(authorization) },
        sourceCoverage: { complete: true }, report: { verdict: 'safe', findings: [] }, resolution: { reasonCodes: [] },
        approval: { schemaVersion: 2, artifactSha256: control.expectedSha256, scannerBuildId: BUILD_ID,
          policySha256: 'b'.repeat(64), decision: 'allow', sourceComplete: true, checks, authorization } };
      const response = change(result, calls.length, control);
      return response === undefined ? { result: { structuredContent: result } } : response;
    }
  }) };
}
function acquisitionError(control) {
  Object.assign(control, { version: null, reference: null, expectedSha256: null, sourceUrl: null, compressedBytes: null });
  control.acquisition = { status: 'error', metadataAttempts: 2, tarballAttempts: 0, error: { code: 'metadata-timeout', message: 'Metadata acquisition did not complete.' } };
}

test('broad cohort sends only exact references through the shared required-check path', async () => {
  const manifest = manifestFixture(), f = fixture(manifest);
  const result = await runBroadControls({ manifest, createClient: f.createClient });
  assert.deepEqual(result.counts, { allow: 32, block: 0, error: 0 });
  assert.equal(result.measurementValid, true); assert.equal(result.allControlsAllowed, true);
  assert.equal(f.initialized, 1); assert.equal(f.closed, 1);
  assert.deepEqual(f.calls.map(c => c.params.arguments), manifest.cases.map(c => ({ reference: `npm:${c.reference}`, outputFormat: 'json' })));
  assert.ok(f.calls.every(c => c.method === 'tools/call' && c.params.name === 'guard_agent_extension_install'));
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.cases.every(c => c.scanAttempted && Number.isFinite(c.wallTimeMs) && c.wallTimeMs >= 0));
  assert.ok(result.cases.every(c => c.checks.directDependencies === 'not-requested' && c.allowAuthorizationValidated));
});

test('size, cohort, malformed identities, strata and duplicate selections fail before client startup', async () => {
  for (const mutate of [
    m => { m.cases.pop(); }, m => { m.selectedCount = 31; }, m => { m.cohortId = 'different'; },
    m => { m.schemaVersion = 2; }, m => { m.cases[5] = structuredClone(m.cases[4]); },
    m => { m.cases[4].version = 'latest'; }, m => { m.cases[4].version = '^1.0.0'; },
    m => { m.cases[4].reference = 'npm:different@1.0.0'; }, m => { m.cases[4].expectedSha256 = 'bad'; },
    m => { m.cases[4].stratum = 'unknown'; }, m => { m.cases[4].stratum = 'larger-libraries'; },
    m => { m.cases[4].packageName = 'replacement'; m.cases[4].reference = 'replacement@1.0.0'; m.cases[4].sourceUrl = 'https://registry.npmjs.org/replacement/-/replacement-1.0.0.tgz'; },
    m => { delete m.cases[4].distIntegrity; }, m => { m.cases[4].acquisition.metadataAttempts = 0; },
    m => { m.cases[4].acquisition.tarballAttempts = 0; },
    m => { m.cases[4].acquisition.status = 'pending'; }, m => { m.cases[4].compressedBytes = 8388609; },
    m => { m.cases[4].sourceUrl = 'https://other.invalid/archive.tgz'; },
    m => { m.cases[0].expectedSha256 = 'c'.repeat(64); }, m => { m.cases[0].selection = 'latest-at-acquisition'; },
    m => { m.limits.maxAttemptsPerResource = 3; }, m => { m.selectionFrozenAt = null; }
  ]) {
    const manifest = manifestFixture(); mutate(manifest); let started = false;
    await assert.rejects(runBroadControls({ manifest, createClient() { started = true; } }), /Invalid broad cohort manifest/);
    assert.equal(started, false, mutate.toString());
  }
});

test('acquisition, request and scan errors retain identities without replacements or raw transport text', async () => {
  const manifest = manifestFixture(); acquisitionError(manifest.cases[5]);
  const f = fixture(manifest, (r, n) => {
    if (n === 2) throw Error('private transport details');
    if (n === 3) return { result: { structuredContent: { scanError: true, verdict: 'block', resolution: { reasonCodes: ['incomplete-checks'] } } } };
  });
  const result = await runBroadControls({ manifest, createClient: f.createClient });
  assert.equal(result.cases.length, 32); assert.equal(f.calls.length, 31);
  assert.deepEqual(result.counts, { allow: 29, block: 0, error: 3 });
  assert.equal(result.cases[5].packageName, manifest.cases[5].packageName);
  assert.equal(result.cases[5].error, 'acquisition-failed'); assert.equal(result.cases[5].wallTimeMs, null);
  assert.equal(result.cases[1].error, 'request-failed'); assert.equal(result.cases[2].error, 'scan-failed');
  assert.deepEqual(result.cases[2].reasonCodes, ['incomplete-checks']);
  assert.doesNotMatch(JSON.stringify(result), /private transport details/);
  assert.equal(result.measurementValid, false); assert.equal(f.closed, 1);
});

test('valid vulnerability and incomplete-check blocks are observations, not false-positive claims', async () => {
  const manifest = manifestFixture();
  const f = fixture(manifest, (r, n) => {
    if (n > 2) return;
    r.decision = 'block'; r.allowed = false; r.assessment.decision = 'block'; r.approval.decision = 'block';
    r.assessment.rawVerdict = n === 1 ? 'block' : 'inconclusive'; r.report.verdict = 'block';
    r.resolution.reasonCodes = n === 1 ? ['blocking-findings'] : ['incomplete-checks'];
    r.report.findings = [{ severity: 'high', category: n === 1 ? 'known-vulnerability' : 'missing-source' }];
    if (n === 2) { r.assessment.checks.source = 'partial'; r.assessment.authorization.mandatoryHoldReasons = ['missing-source']; }
  });
  const result = await runBroadControls({ manifest, createClient: f.createClient });
  assert.equal(result.measurementValid, true); assert.equal(result.allControlsAllowed, false);
  assert.deepEqual(result.counts, { allow: 30, block: 2, error: 0 });
  assert.equal(result.cases[1].rawVerdict, 'inconclusive');
  assert.equal(result.cases[0].findingSeverityCounts.high, 1);
  assert.equal(result.aggregates.blockCategories['known-vulnerability'], 1);
  assert.equal(result.aggregates.checkStates['source:partial'], 1);
  assert.equal(result.aggregates.mandatoryHoldReasons['missing-source'], 1);
  assert.equal(Object.hasOwn(result, 'falsePositives'), false);
});

test('broad allows require matching receipts, artifact, build, policy and coverage', async () => {
  for (const change of [
    r => { r.approval.artifactSha256 = 'c'.repeat(64); }, r => { r.resolved.sha256 = 'c'.repeat(64); },
    r => { r.assessment.engine.buildId = 'c'.repeat(64); }, r => { r.approval.policySha256 = 'c'.repeat(64); },
    r => { r.approval.authorization.behavioralCoverage = 'partial'; }, r => { r.assessment.checks.vulnerabilities = 'disabled'; },
    r => { r.sourceCoverage.complete = false; }, r => { delete r.approval; }
  ]) {
    const manifest = manifestFixture(), f = fixture(manifest, (r, n) => { if (n === 1) change(r); });
    const result = await runBroadControls({ manifest, createClient: f.createClient });
    assert.deepEqual(result.counts, { allow: 31, block: 0, error: 1 });
    assert.equal(result.measurementValid, false); assert.equal(result.cases.length, 32);
  }
});

test('policy drift invalidates the cohort even when each allow receipt is internally consistent', async () => {
  const manifest = manifestFixture(), f = fixture(manifest, (r, n) => {
    if (n === 32) r.approval.policySha256 = r.assessment.policySha256 = 'c'.repeat(64);
  });
  const result = await runBroadControls({ manifest, createClient: f.createClient });
  assert.deepEqual(result.counts, { allow: 32, block: 0, error: 0 });
  assert.equal(result.measurementValid, false); assert.equal(result.allControlsAllowed, false);
  assert.deepEqual(result.sessionErrors, ['policy-changed']);
});

test('manifest validation snapshots selections and never starts transport for acquisition-only errors', async () => {
  const manifest = manifestFixture(), frozen = validateManifest(manifest);
  manifest.cases[4].packageName = 'changed'; assert.notEqual(frozen.cases[4].packageName, 'changed');
  for (const control of frozen.cases) {
    if (control.selection === 'original-control') {
      control.acquisition = { status: 'error', metadataAttempts: 2, tarballAttempts: 0, error: { code: 'metadata-timeout', message: 'Unavailable' } };
    } else acquisitionError(control);
  }
  let started = false;
  const result = await runBroadControls({ manifest: frozen, createClient() { started = true; } });
  assert.equal(started, false); assert.deepEqual(result.counts, { allow: 0, block: 0, error: 32 });
  assert.equal(result.measurementValid, false);
});

test('the broad CLI requires exactly --live and never accepts arbitrary tool or manifest arguments', () => {
  for (const args of [[], ['--live', '--sourceScan=false'], ['--manifest=other.json'], ['--live=false']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/check-broad-controls.js'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/); assert.equal(result.stdout, '');
  }
});

test('initialization and cleanup failures cannot disappear from broad measurement results', async () => {
  const manifest = manifestFixture(); let closed = 0;
  const failed = await runBroadControls({ manifest, createClient: () => ({
    async init() { throw Error('private startup text'); }, async close() { closed++; }
  }) });
  assert.equal(closed, 1); assert.deepEqual(failed.counts, { allow: 0, block: 0, error: 32 });
  assert.equal(failed.measurementValid, false); assert.ok(failed.cases.every(c => c.wallTimeMs === null));
  const f = fixture(manifest);
  const cleaned = await runBroadControls({ manifest, createClient: () => ({ ...f.createClient(), async close() { throw Error('private cleanup text'); } }) });
  assert.equal(cleaned.counts.allow, 32); assert.equal(cleaned.measurementValid, false);
  assert.deepEqual(cleaned.sessionErrors, ['cleanup-failed']);
  assert.doesNotMatch(JSON.stringify([failed, cleaned]), /private (startup|cleanup) text/);
});

test('malformed per-case responses retain later measurements and safe diagnostic categories', async () => {
  const manifest = manifestFixture(), f = fixture(manifest, (r, n) => {
    if (n === 1) return null;
    if (n === 2) { r.report.findings.push({ severity: { toString: null, valueOf: null }, category: 'malformed-fixture' }); }
  });
  const result = await runBroadControls({ manifest, createClient: f.createClient });
  assert.equal(result.cases.length, 32); assert.equal(result.cases[0].error, 'invalid-decision');
  assert.equal(result.cases[1].findingSeverityCounts.other, 1);
  assert.equal(result.counts.error, 1); assert.equal(f.closed, 1);
});
