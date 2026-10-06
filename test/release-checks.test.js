"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyReleaseScan } = require('../scripts/verify-release');
const digest = 'a'.repeat(64);
function fixture() {
  return { resolved: { sha256: digest }, decision: 'review',
    assessment: { checks: { source: 'disabled', vulnerabilities: 'completed' } },
    vulnerabilityPrecheck: { enabled: true, completed: true, error: null, vulnerabilityCount: 0, vulnerabilities: [] },
    report: { verdict: 'review', findings: [{ severity: 'medium', category: 'incomplete-source-scan' }] } };
}
test('release permits only the deliberate source omission after a completed clean advisory check', () => {
  assert.equal(verifyReleaseScan(fixture(), digest).verified, true);
  for (const modify of [
    s => { s.assessment.checks.vulnerabilities = 'failed'; },
    s => { s.vulnerabilityPrecheck.completed = false; },
    s => { s.vulnerabilityPrecheck.enabled = false; },
    s => { s.vulnerabilityPrecheck.error = 'provider unavailable'; },
    s => { s.vulnerabilityPrecheck.vulnerabilities = [{ id: 'fixture' }]; },
    s => { s.resolved.sha256 = 'b'.repeat(64); },
    s => { s.report.findings.push({ severity: 'medium', category: 'flow-analysis-gap' }); },
    s => { s.assessment.authorization = { explicitOverride: true }; }
  ]) { const scan = fixture(); modify(scan); assert.throws(() => verifyReleaseScan(scan, digest)); }
});

test('release checks accept a real scanned benign archive with an offline provider double', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
  const { execFileSync } = require('node:child_process');
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'pkgxray-release-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'package'));
  await fs.writeFile(path.join(dir, 'package/package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  const archive = path.join(dir, 'package.tgz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'package']);
  const bytes = await fs.readFile(archive), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const transport = require('../src/http-client'), original = transport.requestJson;
  transport.requestJson = async url => { assert.equal(url, 'https://api.osv.dev/v1/query'); return {}; };
  t.after(() => { transport.requestJson = original; });
  const scan = await require('../src/quarantine').guardExtension('npm:fixture@1.0.0', {
    config: require('../src/config').DEFAULTS,
    artifact: { archivePath: archive, integrity: `sha256-${Buffer.from(hash, 'hex').toString('base64')}` },
    sourceScan: false, vulnerabilityCheck: true, githubMetadata: false, githubDiff: false, provenance: false
  });
  assert.equal(verifyReleaseScan(scan, hash).verified, true);
});
