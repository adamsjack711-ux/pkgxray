'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditEvidence } = require('../src/auditor');
const root = JSON.stringify({ name: 'root-package', scripts: { postinstall: 'node tests/install.js' } });
const nested = JSON.stringify({ name: 'nested-package', main: './index.js' });
const credentialRead = "module.exports = require('fs').readFileSync('/home/example/.ssh/id_rsa', 'utf8');";

test('root manifest authority is independent of earlier nested manifests and filename lookalikes', () => {
  const entries = [
    ['nested/package.json', nested],
    ['notpackage.json', '{broken'],
    ['package.json', root],
    ['nested/index.js', 'module.exports = 42;'],
    ['tests/install.js', credentialRead]
  ];
  for (const order of [entries, [...entries].reverse(), [entries[1], entries[0], ...entries.slice(2)]]) {
    const report = auditEvidence({ sourceFiles: Object.fromEntries(order) });
    assert.equal(report.verdict, 'block');
    assert.ok(report.findings.some(f => f.category === 'install-hook' && f.file === 'package.json'));
    assert.ok(report.findings.some(f => f.category === 'credential-access' && f.file === 'tests/install.js' && f.severity === 'high'));
  }
});

test('malformed root manifest cannot be replaced by a valid nested manifest', () => {
  const report = auditEvidence({ sourceFiles: {
    'nested/package.json': nested,
    'nested/index.js': 'module.exports = 42;',
    'package.json': '{broken'
  } });
  assert.notEqual(report.verdict, 'safe');
  assert.ok(report.findings.some(f => f.category === 'package-metadata' && f.file === 'package.json' && f.severity === 'medium'));
});

test('only exact manifest basenames qualify when a root manifest is absent', () => {
  const sourceFiles = {
    'notpackage.json': '{broken',
    'wrapper/package.json': JSON.stringify({ name: 'wrapped', scripts: { postinstall: 'node install.js' } }),
    'wrapper/install.js': "console.log('ok');"
  };
  assert.equal(auditEvidence({ sourceFiles }).verdict, 'safe');
  const lookalikeOnly = auditEvidence({ sourceFiles: {
    'notpackage.json': '{"name":"not-a-manifest"}',
    'index.js': 'module.exports = 42;'
  } });
  assert.notEqual(lookalikeOnly.verdict, 'safe');
});

test('stdio MCP keeps root install risk when a nested manifest is supplied first', async t => {
  const { start, call } = require('./helpers/mcp-load-client');
  const client = start(); t.after(() => client.close());
  await client.init();
  const reply = await call(client, { packageName: 'root-package', outputFormat: 'json', sourceFiles: {
    'nested/package.json': nested,
    'nested/index.js': 'module.exports = 42;',
    'package.json': root,
    'tests/install.js': credentialRead
  } });
  const report = reply.result.structuredContent;
  assert.equal(report.verdict, 'block');
  assert.ok(report.findings.some(f => f.category === 'credential-access' && f.severity === 'high'));
});
