'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { SELECTED, LIMITS, registryUrl, integritySpec, verifyIntegrity, fetchResource, acquireCase, acquireManifest } = require('../scripts/acquire-broad-live-cohort');
const bytes = Buffer.from('inert archive fixture');
const digests = Object.fromEntries(['sha256', 'sha384', 'sha512'].map(algorithm => [algorithm, crypto.createHash(algorithm).update(bytes).digest('base64')]));
const sha256 = Buffer.from(digests.sha256, 'base64').toString('hex');
const selected = SELECTED.find(item => item.packageName === 'ms');
const record = { name: 'ms', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/ms/-/ms-1.2.3.tgz', integrity: `sha512-${digests.sha512}` } };
const artifact = { size: bytes.length, digests, sha256 };
const metadata = value => ({ bytes: Buffer.from(JSON.stringify(value)) });
const fail = code => Object.assign(new Error(code), { code });

test('cohort identities and strata are fixed before network acquisition', () => {
  assert.equal(SELECTED.length, 32);
  assert.equal(new Set(SELECTED.map(item => item.packageName)).size, 32);
  const { BENIGN_CONTROLS } = require('../scripts/validate-external-corpus');
  assert.deepEqual(SELECTED.slice(0, 4).map(({ packageName, version, expectedSha256 }) => ({ packageName, version, expectedSha256 })),
    BENIGN_CONTROLS.map(({ packageName, version, artifactSha256 }) => ({ packageName, version, expectedSha256: artifactSha256 })));
  const counts = {};
  for (const item of SELECTED) counts[item.stratum] = (counts[item.stratum] || 0) + 1;
  assert.deepEqual(counts, { utilities: 12, 'larger-libraries': 8, 'framework-tooling': 6, 'network-native': 6 });
});

test('registry authority and integrity algorithms cannot be redirected or downgraded', () => {
  for (const url of ['http://registry.npmjs.org/a', 'https://evil.test/a', 'https://registry.npmjs.org@evil.test/a', 'https://user@registry.npmjs.org/a', 'https://registry.npmjs.org/a?token=x']) assert.throws(() => registryUrl(url));
  for (const sri of [null, 'sha1-YWJj', 'sha512-bad', `sha512-${digests.sha512} bad`]) assert.throws(() => integritySpec(sri));
  const strongerMismatch = `sha256-${digests.sha256} sha512-${Buffer.alloc(64).toString('base64')}`;
  assert.throws(() => verifyIntegrity(integritySpec(strongerMismatch), digests), /mismatch/);
  verifyIntegrity(integritySpec(record.dist.integrity), digests);
});

test('a transient archive retry stays bound to the first resolved metadata and deadline', async () => {
  const calls = [];
  const result = await acquireCase(selected, async (url, options) => {
    calls.push({ url, options });
    if (options.metadata) return metadata(record);
    if (calls.length === 2) throw fail('ECONNRESET');
    return artifact;
  });
  assert.equal(result.acquisition.status, 'verified');
  assert.equal(result.expectedSha256, sha256);
  assert.equal(result.reference, 'ms@1.2.3');
  assert.equal(result.acquisition.metadataAttempts, 1);
  assert.equal(result.acquisition.tarballAttempts, 2);
  assert.equal(calls[1].url, calls[2].url);
  assert.equal(new Set(calls.map(call => call.options.deadline)).size, 1);
  assert.equal(calls[1].options.maxBytes, LIMITS.compressedBytes);
});

test('identity and integrity mismatches stay selected errors without retry or replacement', async () => {
  for (const [badRecord, badArtifact, expected] of [
    [{ ...record, name: 'different' }, artifact, 'registry-identity-mismatch'],
    [record, { ...artifact, digests: { ...digests, sha512: Buffer.alloc(64).toString('base64') } }, 'dist-integrity-mismatch']
  ]) {
    const result = await acquireCase(selected, async (_url, options) => options.metadata ? metadata(badRecord) : badArtifact);
    assert.equal(result.packageName, 'ms');
    assert.equal(result.acquisition.status, 'error');
    assert.equal(result.acquisition.error.code, expected);
    assert.ok(result.acquisition.tarballAttempts <= 1);
    assert.equal(result.expectedSha256, null);
  }
});

test('original control pins cannot silently change', async () => {
  const original = SELECTED[0];
  const result = await acquireCase(original, async (_url, options) => options.metadata ? metadata({ ...record, name: original.packageName, version: original.version }) : artifact);
  assert.equal(result.acquisition.error.code, 'original-control-hash-mismatch');
  assert.equal(result.expectedSha256, original.expectedSha256);
  assert.equal(result.version, original.version);
});

test('size limits fail without retry and transient errors have at most two attempts', async () => {
  for (const [code, attempts] of [['resource-size-limit', 1], ['case-deadline-exceeded', 1], ['ECONNRESET', 2]]) {
    const result = await acquireCase(selected, async () => { throw fail(code); });
    assert.equal(result.acquisition.status, 'error');
    assert.equal(result.acquisition.metadataAttempts, attempts);
  }
});

test('a complete manifest retains all acquisition errors in original selection order', async () => {
  const manifest = await acquireManifest(async () => { throw fail('resource-size-limit'); });
  assert.equal(manifest.selectedCount, 32);
  assert.deepEqual(manifest.cases.map(item => item.packageName), SELECTED.map(item => item.packageName));
  assert.ok(manifest.cases.every(item => item.acquisition.status === 'error'));
  assert.ok(manifest.cases.every(item => item.acquisition.error.code === 'resource-size-limit'));
});

test('streaming acquisition rejects declared or actual excess bytes and does not follow redirects', async () => {
  const originalGet = https.get;
  try {
    for (const scenario of ['declared-size', 'stream-size', 'redirect']) {
      let requests = 0;
      https.get = (_url, _options, receive) => {
        requests++;
        const request = new EventEmitter();
        request.destroy = error => { request.emit('error', error); request.emit('close'); };
        process.nextTick(() => {
          const response = new EventEmitter();
          response.statusCode = scenario === 'redirect' ? 302 : 200;
          response.headers = scenario === 'declared-size' ? { 'content-length': '17' } : {};
          let destroyed = false;
          response.destroy = () => { destroyed = true; response.emit('aborted'); request.emit('close'); };
          receive(response);
          if (!destroyed) response.emit('data', Buffer.alloc(17));
        });
        return request;
      };
      await assert.rejects(fetchResource('https://registry.npmjs.org/ms/latest', { maxBytes: 16, deadline: Date.now() + 1000, metadata: true }),
        error => error.code === (scenario === 'redirect' ? 'registry-http-302' : 'resource-size-limit'));
      assert.equal(requests, 1);
    }
  } finally { https.get = originalGet; }
});
