'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const artifact = require('../src/artifact');
const { guardExtension } = require('../src/quarantine');
const { DEFAULTS } = require('../src/config');
const { parseLockfile, auditLockfile } = require('../src/lockfile');
const offline = { vulnerabilityCheck: false, githubMetadata: false, githubDiff: false, provenance: false };
const sri = (bytes, algorithm = 'sha512') => `${algorithm}-${crypto.createHash(algorithm).update(bytes).digest('base64')}`;
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-binding-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'package'));
  await fs.writeFile(path.join(dir, 'package/package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', main: 'index.js' }));
  await fs.writeFile(path.join(dir, 'package/index.js'), 'module.exports = 42;');
  const file = path.join(dir, 'demo.tgz');
  execFileSync('tar', ['-czf', file, '-C', dir, 'package']);
  return { dir, file, bytes: await fs.readFile(file) };
}
test('archive receipt binds actual bytes, identity, build, policy and disabled checks', async t => {
  const { file, bytes } = await fixture(t);
  const result = await guardExtension('npm:demo@1.0.0', { ...offline, artifact: { archivePath: file, integrity: sri(bytes) } });
  assert.equal(result.decision, 'allow');
  assert.equal(result.approval.artifactSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.approval.scannerBuildId, artifact.BUILD_ID);
  assert.equal(result.approval.policySha256, artifact.fingerprint(DEFAULTS));
  assert.equal(result.approval.name, 'demo');
  assert.equal(result.approval.version, '1.0.0');
  assert.equal(result.approval.sourceComplete, true);
  assert.equal(result.approval.checks.source, 'completed');
  assert.equal(result.approval.checks.vulnerabilities, 'disabled');
});
test('archive rejects changed bytes, mismatched identity and unpinned versions', async t => {
  const { file, bytes } = await fixture(t);
  const options = { ...offline, artifact: { archivePath: file, integrity: sri(bytes) } };
  await assert.rejects(guardExtension('npm:other@1.0.0', options), /identity/i);
  await assert.rejects(guardExtension('npm:demo@2.0.0', options), /identity/i);
  await assert.rejects(guardExtension('npm:demo@latest', options), /exact npm version/);
  await fs.appendFile(file, 'changed');
  await assert.rejects(guardExtension('npm:demo@1.0.0', options), /integrity mismatch/);
});
test('stronger SRI cannot be bypassed by a matching weaker hash', async t => {
  const { file, bytes } = await fixture(t);
  await assert.rejects(artifact.verifyFile(file, `${sri(bytes, 'sha1')} ${sri('wrong', 'sha512')}`), /integrity mismatch/);
  await artifact.verifyFile(file, `${sri('wrong', 'sha1')} ${sri(bytes, 'sha512')}`);
  assert.throws(() => artifact.integrityEntries('sha512-YQ=='), /Malformed/);
});
test('npm lock retains exact artifacts and refuses missing or conflicting identity', async t => {
  const { dir, bytes } = await fixture(t);
  const file = path.join(dir, 'package-lock.json');
  const entry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz', integrity: sri(bytes) };
  await fs.writeFile(file, JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/demo': entry } }));
  const parsed = await parseLockfile(file);
  assert.deepEqual(parsed.deps.get('demo@1.0.0').artifacts, [{ resolved: entry.resolved, integrity: entry.integrity }]);
  for (const packages of [
    { 'node_modules/demo': { version: '1.0.0' } },
    { 'node_modules/demo': entry, 'node_modules/parent/node_modules/demo': { ...entry, integrity: sri('other') } }
  ]) {
    await fs.writeFile(file, JSON.stringify({ lockfileVersion: 3, packages }));
    const result = await auditLockfile(file, { osvResults: [{}], deepAll: true, triageDecisions: false });
    assert.equal(result.worstDecision, 'review');
    assert.match(result.results[0].deep.error, /artifact identity unavailable or conflicting/);
  }
});

test('real scanner receipts authorize the held proxy artifact, then reject altered malicious bytes', async t => {
  const http = require('node:http');
  const { createServer } = await import('../examples/pkgxray-proxy/src/proxy.js');
  const { loadConfig } = await import('../examples/pkgxray-proxy/src/config.js');
  const { VerdictStore } = await import('../examples/pkgxray-proxy/src/verdict-store.js');
  const { dir, file, bytes } = await fixture(t);
  const transport = require('../src/http-client');
  const original = transport.requestJson;
  transport.requestJson = async url => {
    assert.equal(url, 'https://api.osv.dev/v1/query');
    return {};
  };
  t.after(() => { transport.requestJson = original; });
  let current = bytes;
  const upstream = http.createServer((req, res) => res.end(current));
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => upstream.close(r)));
  const config = loadConfig({ upstream: `http://127.0.0.1:${upstream.address().port}`, verdictStorePath: path.join(dir, 'verdict.json'), logDecisions: false }, {});
  let scanned = 0;
  const server = createServer(config, new VerdictStore(config.verdictStorePath), {
    sharedPolicy: null, log: () => {}, runGuard: async (bin, ref, options) => {
      scanned++;
      return guardExtension(`npm:${ref}`, { artifact: options.artifact, githubMetadata: false, githubDiff: false, provenance: false });
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const get = () => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/demo/-/demo-1.0.0.tgz`, { agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const allowed = await get();
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, bytes);
  assert.equal((await get()).status, 200);
  assert.equal(scanned, 1);
  await fs.writeFile(path.join(dir, 'package/index.js'), "require('fs').readFileSync(process.env.HOME+'/.ssh/id_rsa');");
  execFileSync('tar', ['-czf', file, '-C', dir, 'package']);
  current = await fs.readFile(file);
  const blocked = await get();
  assert.equal(blocked.status, 403);
  assert.notDeepEqual(blocked.body, current);
  assert.equal(scanned, 2);
});


test('malformed vulnerability responses cannot count as completed checks', async t => {
  const { file, bytes } = await fixture(t);
  const transport = require('../src/http-client');
  const original = transport.requestJson;
  t.after(() => { transport.requestJson = original; });
  for (const response of [null, [], { vulns: 'unknown' }]) {
    transport.requestJson = async () => response;
    const result = await guardExtension('npm:demo@1.0.0', { githubMetadata: false, githubDiff: false, provenance: false,
      artifact: { archivePath: file, integrity: sri(bytes) } });
    assert.equal(result.decision, 'review');
    assert.equal(result.approval.checks.vulnerabilities, 'failed');
  }
});
