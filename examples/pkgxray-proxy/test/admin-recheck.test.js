import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer, isLoopbackAddress, authorizeAdmin } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { VerdictStore } from '../src/verdict-store.js';

let upstream;
let upstreamUrl;

before(async () => {
  upstream = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
});
after(async () => { await new Promise((r) => upstream.close(r)); });

function startProxy({ runGuard, seed, ...cfgOverrides }) {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-admin-'));
  const config = loadConfig(
    { upstream: upstreamUrl, verdictStorePath: join(dir, 'v.json'), logDecisions: false, ...cfgOverrides },
    {},
  );
  const store = new VerdictStore(config.verdictStorePath);
  if (seed) for (const [n, v, d] of seed) store.set(n, v, d, []);
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

function request(url, method, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('POST /-/pkgxray/recheck re-scans cached entries and flips a regressed verdict', async () => {
  const fresh = { 'good@1.0.0': 'allow', 'gonebad@1.0.0': 'block' };
  const p = await startProxy({
    seed: [['good', '1.0.0', 'allow'], ['gonebad', '1.0.0', 'allow']],
    runGuard: async (bin, ref) => ({ decision: fresh[ref], findings: [] }),
  });
  try {
    const res = await request(`${p.url}/-/pkgxray/recheck`, 'POST');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.ok, true);
    assert.equal(body.total, 2);
    assert.equal(body.changed.length, 1);
    assert.deepEqual(body.changed[0], { name: 'gonebad', version: '1.0.0', from: 'allow', to: 'block' });
    // Store now gates gonebad as block.
    assert.equal(p.store.get('gonebad', '1.0.0').decision, 'block');
  } finally { await p.close(); }
});

test('GET /-/pkgxray/recheck is 405 (POST-only, so a crawler cannot trigger a full re-scan)', async () => {
  const p = await startProxy({ runGuard: async () => ({ decision: 'allow', findings: [] }) });
  try {
    const res = await request(`${p.url}/-/pkgxray/recheck`, 'GET');
    assert.equal(res.status, 405);
  } finally { await p.close(); }
});

test('with adminToken set, POST without a token is 401 and does NOT re-scan', async () => {
  let scanned = 0;
  const p = await startProxy({
    adminToken: 's3cret',
    seed: [['good', '1.0.0', 'allow']],
    runGuard: async () => { scanned += 1; return { decision: 'block', findings: [] }; },
  });
  try {
    const res = await request(`${p.url}/-/pkgxray/recheck`, 'POST');
    assert.equal(res.status, 401);
    assert.equal(scanned, 0, 'an unauthorized request must not trigger any scan');
    // The good stored verdict is untouched.
    assert.equal(p.store.get('good', '1.0.0').decision, 'allow');
  } finally { await p.close(); }
});

test('with adminToken set, a wrong token is 401', async () => {
  const p = await startProxy({
    adminToken: 's3cret',
    runGuard: async () => ({ decision: 'allow', findings: [] }),
  });
  try {
    const res = await request(`${p.url}/-/pkgxray/recheck`, 'POST', { authorization: 'Bearer nope' });
    assert.equal(res.status, 401);
  } finally { await p.close(); }
});

test('with adminToken set, a matching Bearer token is authorized (200)', async () => {
  const p = await startProxy({
    adminToken: 's3cret',
    seed: [['good', '1.0.0', 'allow']],
    runGuard: async () => ({ decision: 'allow', findings: [] }),
  });
  try {
    const res = await request(`${p.url}/-/pkgxray/recheck`, 'POST', { authorization: 'Bearer s3cret' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body.toString()).ok, true);
  } finally { await p.close(); }
});

test('with adminToken set, the x-pkgxray-admin-token header is also accepted', async () => {
  const p = await startProxy({
    adminToken: 's3cret',
    runGuard: async () => ({ decision: 'allow', findings: [] }),
  });
  try {
    const res = await request(`${p.url}/-/pkgxray/recheck`, 'POST', { 'x-pkgxray-admin-token': 's3cret' });
    assert.equal(res.status, 200);
  } finally { await p.close(); }
});

test('isLoopbackAddress accepts loopback forms and rejects routable/empty', () => {
  for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(ok), true, `${ok} should be loopback`);
  }
  for (const no of ['10.0.0.5', '192.168.1.10', '::ffff:10.0.0.5', '', undefined, null, '8.8.8.8']) {
    assert.equal(isLoopbackAddress(no), false, `${no} should not be loopback`);
  }
});

test('authorizeAdmin: no token -> loopback allowed, remote refused with 403', () => {
  const cfg = { adminToken: undefined };
  assert.deepEqual(authorizeAdmin(cfg, { headers: {}, socket: { remoteAddress: '127.0.0.1' } }), { ok: true });
  const remote = authorizeAdmin(cfg, { headers: {}, socket: { remoteAddress: '203.0.113.7' } });
  assert.equal(remote.ok, false);
  assert.equal(remote.status, 403);
  assert.match(remote.message, /adminToken/);
});

test('authorizeAdmin: token configured -> remote with the right token is allowed', () => {
  const cfg = { adminToken: 's3cret' };
  const good = authorizeAdmin(cfg, {
    headers: { authorization: 'Bearer s3cret' },
    socket: { remoteAddress: '203.0.113.7' },
  });
  assert.deepEqual(good, { ok: true });
});
