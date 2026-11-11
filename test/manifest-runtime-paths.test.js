'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditEvidence } = require('../src/auditor');
const harmless = "console.log('setup complete');";
const credentialRead = "module.exports = require('fs').readFileSync('/home/example/.ssh/id_rsa', 'utf8');";
const gaps = report => report.findings.filter(f => f.category === 'unresolved-runtime-execution');
function report(manifest, files) {
  return auditEvidence({ sourceFiles: {
    'workspace/package.json': JSON.stringify({ name: 'manifest-path-fixture', version: '1.0.0', ...manifest }),
    ...files
  } });
}

test('nested manifest hooks resolve from the manifest directory for both command spellings', () => {
  for (const command of ['node ./install.js', 'node install.js']) {
    const result = report({ scripts: { postinstall: command } }, { 'workspace/install.js': harmless });
    assert.equal(result.verdict, 'safe', command);
    assert.deepEqual(gaps(result), []);
    assert.equal(result.findings.find(f => f.category === 'install-hook').lifecycleProof.script.file, 'workspace/install.js');
  }
});

test('a root-level namesake cannot satisfy a missing nested lifecycle target', () => {
  const result = report({ scripts: { postinstall: 'node install.js' } }, { 'install.js': harmless });
  assert.notEqual(result.verdict, 'safe');
  assert.ok(gaps(result).some(f => f.file === 'workspace/install.js'));
});

test('absent developer-only scripts retain the existing non-install treatment', () => {
  for (const command of ['node missing.js', 'node /developer/tool.js', 'node ../../developer/tool.js']) {
    const result = report({ scripts: { test: command } }, { 'workspace/index.js': 'module.exports = 42;' });
    assert.equal(result.verdict, 'safe', command);
    assert.deepEqual(gaps(result), []);
  }
});

test('nested hook targets retain runtime severity through local imports', () => {
  const result = report({ scripts: { postinstall: 'node tests/install.js' } }, {
    'tests/install.js': harmless,
    'workspace/tests/install.js': "require('./secret');",
    'workspace/tests/secret.js': credentialRead
  });
  assert.equal(result.verdict, 'block');
  assert.ok(result.findings.some(f => f.file === 'workspace/tests/secret.js' && f.category === 'credential-access' && f.severity === 'high'));
});

test('declared and default entrypoints resolve beside the selected manifest', () => {
  for (const fields of [{ main: './tests/entry.js' }, { module: './tests/entry.js' },
    { bin: { demo: './tests/entry.js' } }, { exports: { '.': { types: './types.d.ts', import: './tests/entry.js' } } }]) {
    const result = report(fields, { 'tests/entry.js': harmless, 'workspace/tests/entry.js': credentialRead });
    assert.equal(result.verdict, 'block', JSON.stringify(fields));
    assert.ok(result.findings.some(f => f.file === 'workspace/tests/entry.js' && f.category === 'credential-access' && f.severity === 'high'));
  }
  const result = auditEvidence({ sourceFiles: {
    'examples/package.json': '{"name":"default-entry"}',
    'index.js': harmless,
    'examples/index.js': credentialRead
  } });
  assert.equal(result.verdict, 'block');
  assert.ok(result.findings.some(f => f.file === 'examples/index.js' && f.category === 'credential-access' && f.severity === 'high'));
});

test('parent references stay within the artifact and escaping paths remain uncertain', () => {
  const valid = report({ scripts: { postinstall: 'node ../tests/shared.js' } }, { 'tests/shared.js': credentialRead });
  assert.equal(valid.verdict, 'block');
  assert.ok(valid.findings.some(f => f.file === 'tests/shared.js' && f.category === 'credential-access' && f.severity === 'high'));
  for (const command of ['node ../../install.js', 'node /install.js']) {
    const result = report({ scripts: { postinstall: command } }, { 'install.js': harmless, 'workspace/install.js': harmless });
    assert.notEqual(result.verdict, 'safe', command);
    assert.ok(gaps(result).some(f => /outside|escapes/.test(f.rationale)), command);
  }
  for (const main of ['../../install.js', '/install.js', 'C:\\install.js', '\\\\host\\install.js']) {
    const result = report({ main }, { 'install.js': harmless, 'workspace/install.js': harmless });
    assert.notEqual(result.verdict, 'safe', main);
    assert.ok(gaps(result).some(f => /outside|escapes/.test(f.rationale)), main);
  }
});

test('stdio MCP preserves nested-path classification and missing-target blocks', async t => {
  const { start, call } = require('./helpers/mcp-load-client');
  const client = start();
  t.after(() => client.close());
  await client.init();
  for (const [source, expected] of [[harmless, 'safe'], [credentialRead, 'block'], [null, 'block']]) {
    const sourceFiles = {
      'workspace/package.json': JSON.stringify({ name: 'nested-wire-fixture', scripts: { postinstall: 'node tests/install.js' } }),
      'tests/install.js': harmless,
      ...(source === null ? {} : { 'workspace/tests/install.js': source })
    };
    const reply = await call(client, { packageName: 'nested-wire-fixture', sourceFiles, outputFormat: 'json' });
    assert.equal(reply.result.structuredContent.verdict, expected);
    if (source === null) assert.ok(gaps(reply.result.structuredContent).some(f => f.file === 'workspace/tests/install.js'));
  }
});
