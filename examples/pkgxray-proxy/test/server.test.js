import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { withReceipt } from './receipt-helper.js';
import { VerdictStore } from '../src/verdict-store.js';

// --- a fake upstream registry ------------------------------------------------
let upstream;
let upstreamUrl;
let tarballBytes = 'TARBALL-BYTES';
let lastHeaders;
let tarballStatus = 200;

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/lodash') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'meta' });
      res.end(JSON.stringify({ name: 'lodash', 'dist-tags': { latest: '4.17.21' } }));
      return;
    }
    if (req.url.endsWith('.tgz')) {
      lastHeaders = req.headers;
      res.writeHead(tarballStatus, { 'content-type': 'application/octet-stream', 'x-upstream': 'tarball' });
      res.end(Buffer.from(tarballBytes));
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  await new Promise((r) => upstream.close(r));
});

// --- helpers -----------------------------------------------------------------
function startProxy({ runGuard, receipt = true, ...cfgOverrides }) {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-srv-'));
  const config = loadConfig(
    { upstream: upstreamUrl, verdictStorePath: join(dir, 'v.json'), logDecisions: false, ...cfgOverrides },
    {},
  );
  const store = new VerdictStore(config.verdictStorePath);
  const server = createServer(config, store, { runGuard: receipt ? withReceipt(runGuard) : runGuard, sharedPolicy: null, log: () => {} });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        store,
        close: () => new Promise((r) => { server.close(r); rmSync(dir, { recursive: true, force: true }); }),
      });
    });
  });
}

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false, ...options }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// --- tests -------------------------------------------------------------------
test('metadata passes through untouched', async () => {
  const p = await startProxy({ runGuard: async () => ({ decision: 'block', findings: [] }) });
  try {
    const res = await get(`${p.url}/lodash`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-upstream'], 'meta');
    assert.equal(JSON.parse(res.body.toString()).name, 'lodash');
  } finally { await p.close(); }
});

test('allowed tarball streams real bytes with verdict header', async () => {
  const p = await startProxy({ runGuard: async () => ({ decision: 'allow', findings: [] }) });
  try {
    const res = await get(`${p.url}/lodash/-/lodash-4.17.21.tgz`);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'TARBALL-BYTES');
    assert.equal(res.headers['x-pkgxray-verdict'], 'SAFE');
    assert.match(res.headers['x-pkgxray-sha256'], /^[a-f0-9]{64}$/);
  } finally { await p.close(); }
});

test('blocked tarball returns 403 with findings, never releases upstream bytes', async () => {
  const p = await startProxy({
    runGuard: async () => ({ decision: 'block', findings: [{ reason: 'malware' }] }),
  });
  try {
    const res = await get(`${p.url}/evil/-/evil-1.0.0.tgz`);
    assert.equal(res.status, 403);
    assert.equal(res.headers['x-pkgxray-verdict'], 'UNSAFE');
    const body = JSON.parse(res.body.toString());
    assert.equal(body.error, 'blocked_by_pkgxray');
    assert.equal(body.findings[0].reason, 'malware');
  } finally { await p.close(); }
});

test('second request for the same tarball is served from cache (no rescan)', async () => {
  let scans = 0;
  const p = await startProxy({ runGuard: async () => { scans++; return { decision: 'allow', findings: [] }; } });
  try {
    await get(`${p.url}/lodash/-/lodash-4.17.21.tgz`);
    await get(`${p.url}/lodash/-/lodash-4.17.21.tgz`);
    assert.equal(scans, 1, 'the scan should run once; the rest hit cache');
  } finally { await p.close(); }
});

test('verdict persists across a proxy restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-persist-'));
  const storePath = join(dir, 'v.json');
  let scans = 0;
  const runGuard = async () => { scans++; return { decision: 'block', findings: [{ reason: 'x' }] }; };
  try {
    const a = await startProxy({ runGuard, verdictStorePath: storePath });
    const r1 = await get(`${a.url}/evil/-/evil-1.0.0.tgz`);
    assert.equal(r1.status, 403);
    await a.close();

    // Fresh proxy, same store file: should not rescan.
    const b = await startProxy({ runGuard, verdictStorePath: storePath });
    const r2 = await get(`${b.url}/evil/-/evil-1.0.0.tgz`);
    assert.equal(r2.status, 403);
    await b.close();

    assert.equal(scans, 1, 'the cached block survives restart');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scan error refuses unverified bytes even with fail-open configured', async () => {
  const p = await startProxy({
    scanErrorPolicy: 'fail-open',
    runGuard: async () => { throw new Error('boom'); },
  });
  try {
    const res = await get(`${p.url}/lodash/-/lodash-4.17.21.tgz`);
    assert.equal(res.status, 403);
    assert.equal(res.headers['x-pkgxray-verdict'], 'UNSAFE');
    assert.ok(!res.body.includes('TARBALL-BYTES'));
  } finally { await p.close(); }
});


test('same name and version with changed upstream bytes requires a new scan', async () => {
  let scans = 0;
  const p = await startProxy({ runGuard: async () => ({ decision: ++scans === 1 ? 'allow' : 'block', findings: [] }) });
  try {
    assert.equal((await get(`${p.url}/demo/-/demo-1.0.0.tgz`)).status, 200);
    tarballBytes = 'SWAPPED-MALICIOUS-BYTES';
    const res = await get(`${p.url}/demo/-/demo-1.0.0.tgz`);
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes(tarballBytes));
    assert.equal(scans, 2);
  } finally { tarballBytes = 'TARBALL-BYTES'; await p.close(); }
});

test('missing and mismatched receipts never release bytes, even for allowlisted names', async () => {
  for (const mutate of [() => undefined,
    a => ({ ...a, artifactSha256: '0'.repeat(64) }),
    a => ({ ...a, scannerBuildId: 'old-build' }),
    a => ({ ...a, policySha256: 'old-policy' }),
    a => ({ ...a, name: 'other' }),
    a => ({ ...a, sourceComplete: false }),
    a => ({ ...a, checks: { source: 'completed', vulnerabilities: 'disabled' } })]) {
    const stub = withReceipt(async () => ({ decision: 'allow', findings: [] }));
    const p = await startProxy({ receipt: false, allowlist: ['demo'], runGuard: async (...args) => {
      const result = await stub(...args);
      return { ...result, approval: mutate(result.approval) };
    } });
    try {
      const res = await get(`${p.url}/demo/-/demo-1.0.0.tgz`);
      assert.equal(res.status, 403);
      assert.equal(res.headers['x-pkgxray-verdict'], 'UNSAFE');
      assert.ok(!res.body.includes(tarballBytes));
    } finally { await p.close(); }
  }
});

test('legacy cache entries cannot authorize delivery and stale failures stay closed', async () => {
  let scans = 0;
  const p = await startProxy({ verdictTtlMs: 0, runGuard: async () => {
    if (++scans > 1) throw new Error('offline');
    return { decision: 'allow', findings: [] };
  } });
  try {
    p.store.set('demo', '1.0.0', 'allow', []);
    assert.equal((await get(`${p.url}/demo/-/demo-1.0.0.tgz`)).status, 200);
    assert.equal(scans, 1);
    assert.equal((await get(`${p.url}/demo/-/demo-1.0.0.tgz`)).status, 403);
    assert.equal(scans, 2);
  } finally { await p.close(); }
});

test('client range is stripped and a partial upstream response is rejected before scanning', async () => {
  let scans = 0;
  const p = await startProxy({ runGuard: async () => { scans++; return { decision: 'allow', findings: [] }; } });
  try {
    const res = await get(`${p.url}/demo/-/demo-1.0.0.tgz`, { headers: { range: 'bytes=0-1', 'if-none-match': 'old' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), tarballBytes);
    assert.equal(lastHeaders.range, undefined);
    assert.equal(lastHeaders['if-none-match'], undefined);
    tarballStatus = 206;
    const partial = await get(`${p.url}/demo/-/demo-1.0.0.tgz`);
    assert.ok(partial.status >= 400);
    assert.equal(scans, 1);
    assert.ok(!partial.body.includes(tarballBytes));
  } finally { tarballStatus = 200; await p.close(); }
});

test('HTTP review requires evidence and a session-scoped explicit choice before delivery', async () => {
  let scans = 0;
  const proxy = await startProxy({ reviewPolicy: 'allow', runGuard: async () => {
    scans++; return { decision: 'review', findings: [{ reason: 'inspect this behavior' }] };
  } });
  async function choose(session, reviewId, choice) {
    const res = await fetch(`${proxy.url}/-/pkgxray/review`, { method: 'POST',
      headers: { 'x-pkgxray-session': session, 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId, choice }) });
    return res.status;
  }
  try {
    const url = `${proxy.url}/demo/-/demo-1.0.0.tgz`;
    const first = await get(url), second = await get(url);
    assert.equal(first.status, 409); assert.equal(second.status, 409);
    assert.equal(first.headers['x-pkgxray-verdict'], 'PENDING');
    const evidence = JSON.parse(first.body);
    assert.equal(evidence.outcome, null);
    assert.equal(evidence.findings[0].reason, 'inspect this behavior');
    const a = first.headers['x-pkgxray-session'], b = second.headers['x-pkgxray-session'];
    assert.notEqual(a, b);
    assert.equal(await choose('unknown', evidence.review.id, 'Proceed'), 401);
    assert.equal(await choose(a, 'wrong-review', 'Proceed'), 400);
    assert.equal(await choose(a, evidence.review.id, 'Proceed'), 200);
    assert.equal((await get(url, { headers: { 'x-pkgxray-session': a } })).status, 200);
    assert.equal((await get(url, { headers: { 'x-pkgxray-session': a } })).status, 200);
    assert.equal((await get(url, { headers: { 'x-pkgxray-session': b } })).status, 409);
    assert.equal(await choose(b, evidence.review.id, 'Decline'), 200);
    assert.equal((await get(url, { headers: { 'x-pkgxray-session': b } })).status, 403);
    assert.equal(scans, 1);
    assert.equal(lastHeaders['x-pkgxray-session'], undefined);
  } finally { await proxy.close(); }
});
