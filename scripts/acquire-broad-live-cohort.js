#!/usr/bin/env node
'use strict';

// Registry metadata and archive bytes only: no extraction, package execution,
// scanner invocation, dependency installation, or retained archive payloads.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');

const COHORT_ID = 'established-package-candidates-2026-11-11';
const LIMITS = Object.freeze({ metadataBytes: 1024 * 1024, compressedBytes: 8 * 1024 * 1024,
  caseDeadlineMs: 30000, maxAttemptsPerResource: 2, concurrency: 4 });
const ORIGINAL = [
  ['escape-string-regexp', '5.0.0', 'c8b662afe8aa2b852ecc27d766e584a502f8351fbbd890611f2509bf083d28e6'],
  ['is-number', '7.0.0', '7b75c1057198cf97696909a9bee176c9c5e9bcb5b03bf3ecef2f484defadd51e'],
  ['picocolors', '1.1.1', 'd3aedb2807967b7eb37fd11b03b7e3701e725af79c650d0812ff7213f8f882d9'],
  ['yocto-queue', '1.2.1', '2b3bd9bfcd6ca5e17556846221a11e15b43c81f76cb6bce3059405fed9753055']
];
const STRATA = Object.freeze({
  utilities: ['ms', 'is-plain-obj', 'ansi-regex', 'strip-ansi', 'escape-html', 'fast-deep-equal', 'once', 'wrappy'],
  'larger-libraries': ['lodash', 'minimatch', 'semver', 'glob', 'debug', 'chalk', 'commander', 'uuid'],
  'framework-tooling': ['react', 'express', 'typescript', 'vite', 'esbuild', 'rollup'],
  'network-native': ['undici', 'axios', 'ws', 'tar', 'sharp', '@modelcontextprotocol/sdk']
});
const SELECTED = Object.freeze([
  ...ORIGINAL.map(([packageName, version, expectedSha256]) => Object.freeze({ packageName, version, expectedSha256,
    stratum: 'utilities', selection: 'original-control' })),
  ...Object.entries(STRATA).flatMap(([stratum, names]) => names.map(packageName => Object.freeze({ packageName,
    stratum, selection: 'latest-at-acquisition' })))
]);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function failure(code) { const error = new Error(code); error.code = code; return error; }
function registryUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid-registry-url'); }
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.hash || url.search) throw failure('untrusted-registry-url');
  return url;
}
function integritySpec(value) {
  if (typeof value !== 'string' || value.length > 4096) throw failure('missing-or-invalid-dist-integrity');
  const tokens = value.trim().split(/\s+/).map(token => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) throw failure('unsupported-dist-integrity');
    const decoded = Buffer.from(match[2], 'base64');
    if (decoded.toString('base64') !== match[2] || decoded.length !== { sha256: 32, sha384: 48, sha512: 64 }[match[1]]) throw failure('invalid-dist-integrity-digest');
    return { algorithm: match[1], digest: match[2] };
  });
  const strongest = ['sha512', 'sha384', 'sha256'].find(algorithm => tokens.some(token => token.algorithm === algorithm));
  return tokens.filter(token => token.algorithm === strongest);
}
function verifyIntegrity(spec, digests) {
  if (!spec.some(token => digests[token.algorithm] === token.digest)) throw failure('dist-integrity-mismatch');
}
function fetchResource(value, { maxBytes, deadline, metadata }) {
  const url = registryUrl(value);
  if (Date.now() >= deadline) return Promise.reject(failure('case-deadline-exceeded'));
  return new Promise((resolve, reject) => {
    const hashes = Object.fromEntries(['sha256', 'sha384', 'sha512'].map(algorithm => [algorithm, crypto.createHash(algorithm)]));
    const chunks = []; let size = 0;
    const req = https.get(url, { headers: { 'user-agent': 'pkgxray-cohort-acquisition', accept: metadata ? 'application/json' : 'application/octet-stream', 'accept-encoding': 'identity' } }, res => {
      if (res.statusCode !== 200) {
        const error = failure(`registry-http-${res.statusCode}`); error.statusCode = res.statusCode;
        res.destroy(); reject(error); return;
      }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { reject(failure('unexpected-content-encoding')); res.destroy(); return; }
      if (Number(res.headers['content-length']) > maxBytes) { reject(failure('resource-size-limit')); res.destroy(); return; }
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { reject(failure('resource-size-limit')); res.destroy(); return; }
        for (const hash of Object.values(hashes)) hash.update(chunk);
        if (metadata) chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(failure('response-aborted')));
      res.on('end', () => {
        if (!res.complete) { reject(failure('response-aborted')); return; }
        const digests = Object.fromEntries(Object.entries(hashes).map(([algorithm, hash]) => [algorithm, hash.digest('base64')]));
        resolve({ size, digests, sha256: Buffer.from(digests.sha256, 'base64').toString('hex'), ...(metadata ? { bytes: Buffer.concat(chunks) } : {}) });
      });
    });
    const timer = setTimeout(() => req.destroy(failure('case-deadline-exceeded')), Math.max(1, deadline - Date.now()));
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}
function transient(error) {
  return error.statusCode === 429 || error.statusCode >= 500 || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'response-aborted'].includes(error.code);
}
async function acquireCase(selected, fetch = fetchResource) {
  const result = { packageName: selected.packageName, stratum: selected.stratum, selection: selected.selection,
    version: selected.version || null, reference: selected.version ? `${selected.packageName}@${selected.version}` : null,
    expectedSha256: selected.expectedSha256 || null, sourceUrl: null, distIntegrity: null, compressedBytes: null,
    acquisition: { status: 'error', metadataAttempts: 0, tarballAttempts: 0 } };
  const deadline = Date.now() + LIMITS.caseDeadlineMs;
  const request = async (url, metadata) => {
    const count = metadata ? 'metadataAttempts' : 'tarballAttempts';
    for (;;) {
      result.acquisition[count]++;
      try { return await fetch(url, { maxBytes: metadata ? LIMITS.metadataBytes : LIMITS.compressedBytes, deadline, metadata }); }
      catch (error) { if (result.acquisition[count] >= LIMITS.maxAttemptsPerResource || !transient(error) || Date.now() >= deadline) throw error; }
    }
  };
  try {
    const metadata = await request(`https://registry.npmjs.org/${encodeURIComponent(selected.packageName)}/${selected.version || 'latest'}`, true);
    let record;
    try { record = JSON.parse(metadata.bytes.toString('utf8')); } catch { throw failure('invalid-registry-metadata'); }
    if (record.name !== selected.packageName || typeof record.version !== 'string' || !VERSION.test(record.version) || (selected.version && record.version !== selected.version)) throw failure('registry-identity-mismatch');
    result.version = record.version;
    result.reference = `${selected.packageName}@${record.version}`;
    result.sourceUrl = registryUrl(record.dist?.tarball).href;
    const spec = integritySpec(record.dist?.integrity);
    result.distIntegrity = record.dist.integrity;
    // Once the metadata resolves, retries use these exact archive coordinates.
    // The mutable latest tag is never consulted again for this selected case.
    const artifact = await request(result.sourceUrl, false);
    result.compressedBytes = artifact.size;
    verifyIntegrity(spec, artifact.digests);
    if (selected.expectedSha256 && artifact.sha256 !== selected.expectedSha256) throw failure('original-control-hash-mismatch');
    result.expectedSha256 = artifact.sha256;
    result.acquisition.status = 'verified';
  } catch (error) {
    const code = String(error.code || 'acquisition-failed').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'acquisition-failed';
    result.acquisition.error = { code, message: code };
  }
  return result;
}
async function acquireManifest(fetch = fetchResource) {
  const selectionFrozenAt = new Date().toISOString();
  const cases = new Array(SELECTED.length); let next = 0;
  await Promise.all(Array.from({ length: LIMITS.concurrency }, async () => {
    while (next < SELECTED.length) { const index = next++; cases[index] = await acquireCase(SELECTED[index], fetch); }
  }));
  return { schemaVersion: 1, cohortId: COHORT_ID, selectedCount: SELECTED.length, selectionFrozenAt,
    acquiredAt: new Date().toISOString(), selection: 'Four original exact controls plus 28 names fixed before acquisition; resolve latest once successfully, then bind exact version and verified tarball bytes. No replacement on acquisition errors; no scanner used during selection or acquisition.',
    label: 'Project-selected established-package candidates, not certified benign; vulnerabilities can justify blocks.',
    limits: LIMITS, cases };
}
async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/acquire-broad-live-cohort.js NEW_OUTPUT.json');
  const destination = path.resolve(process.argv[2]);
  // Reserve output before network access: reruns cannot silently replace a
  // frozen manifest or resolve its latest selections again under the same file.
  const handle = await fs.open(destination, 'wx', 0o644);
  try { await handle.writeFile(`${JSON.stringify(await acquireManifest(), null, 2)}\n`); }
  finally { await handle.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { COHORT_ID, LIMITS, SELECTED, registryUrl, integritySpec, verifyIntegrity, fetchResource, acquireCase, acquireManifest };
