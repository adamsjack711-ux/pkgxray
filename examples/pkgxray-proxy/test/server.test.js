import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { VerdictStore } from '../src/verdict-store.js';

// --- a fake upstream registry ------------------------------------------------
let upstream;
let upstreamUrl;

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/lodash') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'meta' });
      res.end(JSON.stringify({ name: 'lodash', 'dist-tags': { latest: '4.17.21' } }));
      return;
    }
    if (req.url.endsWith('.tgz')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-upstream': 'tarball' });
      res.end(Buffer.from('TARBALL-BYTES'));
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
function startProxy({ runGuard, ...cfgOverrides }) {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-srv-'));
  const config = loadConfig(
    { upstream: upstreamUrl, verdictStorePath: join(dir, 'v.json'), logDecisions: false, ...cfgOverrides },
    {},
  );
  const store = new VerdictStore(config.verdictStorePath);
  const server = createServer(config, store, { runGuard, log: () => {} });
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

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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
    assert.equal(res.headers['x-pkgxray-verdict'], 'allow');
    assert.equal(res.headers['x-upstream'], 'tarball');
  } finally { await p.close(); }
});

test('blocked tarball returns 403 with findings, never touches upstream body', async () => {
  const p = await startProxy({
    runGuard: async () => ({ decision: 'block', findings: [{ reason: 'malware' }] }),
  });
  try {
    const res = await get(`${p.url}/evil/-/evil-1.0.0.tgz`);
    assert.equal(res.status, 403);
    assert.equal(res.headers['x-pkgxray-verdict'], 'block');
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

test('scan error + fail-open serves with scan-error header', async () => {
  const p = await startProxy({
    scanErrorPolicy: 'fail-open',
    runGuard: async () => { throw new Error('boom'); },
  });
  try {
    const res = await get(`${p.url}/lodash/-/lodash-4.17.21.tgz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-pkgxray-verdict'], 'scan-error');
    assert.equal(res.body.toString(), 'TARBALL-BYTES');
  } finally { await p.close(); }
});
