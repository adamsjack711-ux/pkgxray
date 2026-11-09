import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
let tarballDelayMs = 0;
let activeDownloads = 0;
let maxActiveDownloads = 0;
let transportActive = 0;

before(async () => {
  upstream = http.createServer((req, res) => {
    const transport = req.url.match(/^\/(?:-\/)?transport-(silent|truncated|drip|blocked|echo)$/);
    if (transport) {
      transportActive++;
      res.once('close', () => transportActive--);
      if (transport[1] === 'echo') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(Buffer.concat(chunks)); });
      } else if (transport[1] === 'truncated') {
        res.writeHead(200, { 'content-length': 100 }); res.write('partial');
        const timer = setTimeout(() => res.destroy(), 10);
        res.on('close', () => clearTimeout(timer));
      } else if (transport[1] === 'drip') {
        res.writeHead(200); res.write('partial');
        const timer = setInterval(() => res.write('x'), 15);
        res.on('close', () => clearInterval(timer));
      } else if (transport[1] === 'blocked') {
        res.writeHead(200, { 'content-length': 16 * 1024 * 1024 });
        res.end(Buffer.alloc(16 * 1024 * 1024));
      }
      // silent intentionally retains the connection without sending headers.
      return;
    }
    if (req.url === '/lodash') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'meta' });
      res.end(JSON.stringify({ name: 'lodash', 'dist-tags': { latest: '4.17.21' } }));
      return;
    }
    if (req.url === '/headers' || req.url === '/errorheaders' || req.url === '/-/headers') {
      lastHeaders = req.headers;
      res.writeHead(req.url === '/errorheaders' ? 404 : 200, {
        'content-type': 'application/json',
        connection: 'keep-alive, x-private-hop', 'x-private-hop': 'must-not-forward',
        'keep-alive': 'timeout=500', 'proxy-authenticate': 'secret',
        trailer: 'x-trailer', etag: 'upstream-validator', digest: 'sha-256=upstream-digest',
      });
      res.write(JSON.stringify({ name: 'headers' }));
      res.addTrailers({ 'x-trailer': 'must-not-forward' });
      res.end(); return;
    }
    if (req.url === '/truncated' || req.url === '/drip' || req.url === '/oversized') {
      if (req.url === '/truncated') {
        res.writeHead(200, { 'content-length': 100 }); res.write('{');
        const timer = setTimeout(() => res.destroy(), 10);
        res.on('close', () => clearTimeout(timer));
      } else if (req.url === '/drip') {
        res.writeHead(200); res.write('{');
        const timer = setInterval(() => res.write(' '), 15);
        res.on('close', () => clearInterval(timer));
      } else res.end('x'.repeat(9 * 1024 * 1024));
      return;
    }
    if (req.url === '/alternate') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'alternate', versions: { '1.0.0': {
        name: 'alternate', version: '1.0.0', dist: { tarball: `${upstreamUrl}/downloads/alternate/archive` }
      } } }));
      return;
    }
    if (req.url === '/badidentity') {
      res.end(JSON.stringify({ name: {}, version: '1.0.0', dist: { tarball: `${upstreamUrl}/downloads/alternate/archive` } }));
      return;
    }
    if (req.url === '/downloads/alternate/archive') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(tarballBytes));
      return;
    }
    if (req.url.endsWith('.tgz')) {
      lastHeaders = req.headers;
      activeDownloads++;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
      setTimeout(() => {
        res.writeHead(tarballStatus, { 'content-type': 'application/octet-stream', 'x-upstream': 'tarball' });
        res.end(Buffer.from(tarballBytes));
        activeDownloads--;
      }, tarballDelayMs);
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
function startProxy({ runGuard, receipt = true, metadataTimeoutMs, ...cfgOverrides }) {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-srv-'));
  const config = loadConfig(
    { upstream: upstreamUrl, verdictStorePath: join(dir, 'v.json'), logDecisions: false, ...cfgOverrides },
    {},
  );
  const store = new VerdictStore(config.verdictStorePath);
  const server = createServer(config, store, { runGuard: receipt ? withReceipt(runGuard) : runGuard, sharedPolicy: null, log: () => {}, metadataTimeoutMs });
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
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('response aborted')));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { agent: false, method: 'POST', headers: { 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('response aborted')));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function waitForTransportCleanup() {
  const deadline = Date.now() + 1500;
  while (transportActive && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(transportActive, 0, 'proxy must close the upstream transport');
}

// --- tests -------------------------------------------------------------------
test('metadata keeps document fields and end-to-end upstream headers', async () => {
  const p = await startProxy({ runGuard: async () => ({ decision: 'block', findings: [] }) });
  try {
    const res = await get(`${p.url}/lodash`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-upstream'], 'meta');
    assert.equal(JSON.parse(res.body.toString()).name, 'lodash');
  } finally { await p.close(); }
});

for (const kind of ['service', 'metadata-post']) {
  for (const behavior of ['silent', 'truncated', 'drip']) {
    test(`${kind} passthrough terminates ${behavior} upstream and cleans up its socket`, { timeout: 4000 }, async () => {
      const p = await startProxy({ metadataTimeoutMs: 160, runGuard: async () => ({ decision: 'block', findings: [] }) });
      try {
        const started = Date.now();
        const result = kind === 'service' ? get(`${p.url}/-/transport-${behavior}`) : post(`${p.url}/transport-${behavior}`, '{}');
        if (behavior === 'silent') {
          const response = await result;
          assert.equal(response.status, 502);
          assert.match(response.body.toString(), /total deadline/);
        } else await assert.rejects(result, /aborted|reset|closed/i);
        assert.ok(Date.now() - started < 1500);
        await waitForTransportCleanup();
        const body = '{"operation":"still-works"}';
        const retry = await post(`${p.url}${kind === 'service' ? '/-/' : '/'}transport-echo`, body);
        assert.equal(retry.status, 201);
        assert.equal(retry.body.toString(), body);
      } finally { await p.close(); }
    });
  }
}

test('registry passthrough deadline cancels blocked client output', { timeout: 4000 }, async () => {
  const p = await startProxy({ metadataTimeoutMs: 160, runGuard: async () => ({ decision: 'block', findings: [] }) });
  let request, response, completion;
  try {
    await new Promise((resolve, reject) => {
      request = http.get(`${p.url}/-/transport-blocked`, { agent: false }, incoming => {
        response = incoming;
        completion = new Promise((complete, failed) => {
          response.on('end', complete);
          response.on('error', failed);
          response.on('aborted', () => failed(new Error('response aborted')));
        });
        completion.catch(() => {});
        response.pause();
        resolve();
      });
      request.on('error', reject);
    });
    await waitForTransportCleanup();
    response.resume();
    await assert.rejects(completion, /aborted|reset|closed/i);
  } finally { response?.destroy(); request?.destroy(); await p.close(); }
});

test('registry passthrough cancels a streaming upstream when its response client disconnects', { timeout: 4000 }, async () => {
  const p = await startProxy({ metadataTimeoutMs: 1000, runGuard: async () => ({ decision: 'block', findings: [] }) });
  try {
    await new Promise((resolve, reject) => {
      http.get(`${p.url}/-/transport-drip`, { agent: false }, response => {
        response.on('error', () => {});
        response.destroy(); resolve();
      }).on('error', reject);
    });
    await waitForTransportCleanup();
  } finally { await p.close(); }
});

test('registry passthrough cancels upstream when a client aborts its request upload', { timeout: 4000 }, async () => {
  const p = await startProxy({ metadataTimeoutMs: 1000, runGuard: async () => ({ decision: 'block', findings: [] }) });
  let request;
  try {
    request = http.request(`${p.url}/-/transport-silent`, { agent: false, method: 'POST', headers: { 'content-length': 100 } });
    request.on('error', () => {});
    request.write('partial');
    const deadline = Date.now() + 1000;
    while (!transportActive && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(transportActive, 1);
    request.destroy();
    await waitForTransportCleanup();
  } finally { request?.destroy(); await p.close(); }
});

test('approved artifact output has a deadline when its client stops reading', { timeout: 4000 }, async () => {
  const previousBytes = tarballBytes;
  tarballBytes = 'x'.repeat(16 * 1024 * 1024);
  let archivePath;
  const p = await startProxy({ metadataTimeoutMs: 160, runGuard: async (_bin, _ref, opts) => {
    archivePath = opts.artifact.archivePath;
    return { decision: 'allow', findings: [] };
  } });
  let request, response, completion;
  try {
    await new Promise((resolve, reject) => {
      request = http.get(`${p.url}/blocked-output/-/blocked-output-1.0.0.tgz`, { agent: false }, incoming => {
        response = incoming;
        assert.equal(response.headers['x-pkgxray-verdict'], 'allow');
        completion = new Promise((complete, failed) => {
          response.on('end', complete);
          response.on('error', failed);
          response.on('aborted', () => failed(new Error('response aborted')));
        });
        completion.catch(() => {});
        response.pause(); resolve();
      });
      request.on('error', reject);
    });
    // Give the server deadline time to cancel the blocked write, then read
    // queued bytes so the client observes the truncated HTTP response.
    await new Promise(resolve => setTimeout(resolve, 220));
    response.resume();
    await assert.rejects(completion, /aborted|reset|closed/i);
    const cleanupDeadline = Date.now() + 1500;
    while (existsSync(archivePath) && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(archivePath), false, 'cancelled delivery must remove its private snapshot');
    assert.equal((await get(`${p.url}/lodash`)).status, 200);
  } finally { tarballBytes = previousBytes; response?.destroy(); request?.destroy(); await p.close(); }
});

for (const route of ['/headers', '/errorheaders', '/-/headers']) {
  test(`${route} strips hop-by-hop response and request headers`, async () => {
    const p = await startProxy({ runGuard: async () => ({ decision: 'block', findings: [] }) });
    try {
      const res = await get(`${p.url}${route}`, { headers: {
        connection: 'close, x-client-hop', 'x-client-hop': 'must-not-forward',
        'proxy-authorization': 'must-not-forward', 'x-client-end': 'retained',
      } });
      assert.equal(res.status, route === '/errorheaders' ? 404 : 200);
      assert.equal(res.headers['x-private-hop'], undefined);
      assert.equal(res.headers['proxy-authenticate'], undefined);
      assert.equal(res.headers.trailer, undefined);
      assert.notEqual(res.headers['keep-alive'], 'timeout=500');
      assert.equal(lastHeaders['x-client-hop'], undefined);
      assert.equal(lastHeaders['proxy-authorization'], undefined);
      assert.equal(lastHeaders['x-client-end'], 'retained');
      if (route !== '/-/headers') {
        assert.equal(res.headers['transfer-encoding'], undefined);
        assert.equal(Number(res.headers['content-length']), res.body.length);
      }
      if (route === '/headers') {
        assert.equal(res.headers.etag, undefined);
        assert.equal(res.headers.digest, undefined);
      }
    } finally { await p.close(); }
  });
}

for (const behavior of ['truncated', 'drip', 'oversized']) {
  test(`metadata ${behavior} upstream fails promptly without releasing an incomplete document`, { timeout: 4000 }, async () => {
    const p = await startProxy({ metadataTimeoutMs: 160, runGuard: async () => ({ decision: 'block', findings: [] }) });
    try {
      const started = Date.now();
      const res = await get(`${p.url}/${behavior}`);
      assert.equal(res.status, 502);
      assert.equal(JSON.parse(res.body).error, 'upstream_error');
      assert.ok(Date.now() - started < 1500);
      const retry = await get(`${p.url}/lodash`);
      assert.equal(retry.status, 200);
    } finally { await p.close(); }
  });
}

test('metadata rewrites a same-origin noncanonical tarball through the gate', async () => {
  let scans = 0;
  const p = await startProxy({ runGuard: async () => { scans++; return { decision: 'block', findings: [{ reason: 'blocked' }] }; } });
  try {
    const metadata = await get(`${p.url}/alternate`);
    const tarball = JSON.parse(metadata.body).versions['1.0.0'].dist.tarball;
    assert.match(tarball, new RegExp(`^${p.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/-/pkgxray/artifact/`));
    const artifact = await get(tarball);
    assert.equal(artifact.status, 403);
    assert.equal(scans, 1);
    assert.equal(artifact.body.includes(tarballBytes), false);
    const direct = await get(`${p.url}/downloads/alternate/archive`);
    assert.equal(direct.status, 404);
  } finally { await p.close(); }
});

test('malformed metadata identities cannot crash tarball rewriting or authorize delivery', async () => {
  let scans = 0;
  const p = await startProxy({ runGuard: async () => { scans++; return { decision: 'block', findings: [] }; } });
  try {
    const metadata = await get(`${p.url}/badidentity`);
    assert.equal(metadata.status, 502);
    assert.equal(JSON.parse(metadata.body).error, 'invalid_registry_metadata');
    assert.ok(!metadata.body.includes('/downloads/alternate/archive'));
    const direct = await get(`${p.url}/downloads/alternate/archive`);
    assert.equal(direct.status, 404);
    assert.equal(scans, 0);
    assert.equal((await get(`${p.url}/lodash`)).status, 200);
  } finally { await p.close(); }
});

test('artifact acquisition obeys the configured concurrency limit and HEAD does no work', async () => {
  tarballDelayMs = 50;
  maxActiveDownloads = 0;
  const p = await startProxy({ scanConcurrency: 2, maxPendingScans: 20,
    runGuard: async () => ({ decision: 'block', findings: [] }) });
  try {
    const paths = Array.from({ length: 8 }, (_, i) => `${p.url}/pkg${i}/-/pkg${i}-1.0.0.tgz`);
    const results = await Promise.all(paths.map(url => get(url)));
    assert.ok(results.every(result => result.status === 403));
    assert.ok(maxActiveDownloads <= 2, `observed ${maxActiveDownloads} concurrent downloads`);
    const before = maxActiveDownloads;
    const head = await get(paths[0], { method: 'HEAD' });
    assert.equal(head.status, 405);
    assert.equal(maxActiveDownloads, before);
  } finally { tarballDelayMs = 0; await p.close(); }
});

test('allowed tarball streams real bytes with verdict header', async () => {
  const p = await startProxy({ runGuard: async () => ({ decision: 'allow', findings: [] }) });
  try {
    const res = await get(`${p.url}/lodash/-/lodash-4.17.21.tgz`);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'TARBALL-BYTES');
    assert.equal(res.headers['x-pkgxray-verdict'], 'allow');
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

test('default policy withholds reviewed archives on fresh and cached decisions', async () => {
  let scans = 0;
  const p = await startProxy({ runGuard: async () => { scans++; return { decision: 'review', findings: [{ reason: 'manual review required' }] }; } });
  try {
    for (const source of ['scan', 'cache']) {
      const res = await get(`${p.url}/demo/-/demo-1.0.0.tgz`);
      assert.equal(res.status, 403);
      assert.equal(res.headers['x-pkgxray-source'], source);
      assert.equal(res.headers['x-pkgxray-verdict'], 'review');
      assert.ok(!res.body.includes(tarballBytes));
      assert.match(JSON.parse(res.body).note, /requires review/);
    }
    assert.equal(scans, 1);
  } finally { await p.close(); }
});

test('permissive review policy still withholds cached incomplete receipts and preserves findings', async () => {
  let scans = 0;
  const incomplete = withReceipt(async () => {
    scans++;
    return { decision: 'review', findings: [{ category: 'incomplete-source-scan', reason: 'coverage is incomplete' }] };
  });
  const p = await startProxy({ receipt: false, reviewPolicy: 'allow', runGuard: async (...args) => {
    const result = await incomplete(...args);
    result.approval.sourceComplete = false;
    return result;
  } });
  try {
    for (const source of ['scan', 'cache']) {
      const res = await get(`${p.url}/demo/-/demo-1.0.0.tgz`);
      assert.equal(res.status, 403);
      assert.equal(res.headers['x-pkgxray-source'], source);
      assert.equal(res.headers['x-pkgxray-verdict'], 'unbound');
      assert.ok(!res.body.includes(tarballBytes));
      assert.equal(JSON.parse(res.body).findings[0].category, 'incomplete-source-scan');
    }
    assert.equal(scans, 1);
  } finally { await p.close(); }
});

test('pending approval releases no response bytes while metadata remains available', async () => {
  let release, markStarted;
  const approval = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const p = await startProxy({ runGuard: async () => { markStarted(); await approval; return { decision: 'allow', findings: [] }; } });
  let responseStarted = false;
  const download = new Promise((resolve, reject) => {
    http.get(`${p.url}/demo/-/demo-1.0.0.tgz`, { agent: false }, res => {
      responseStarted = true;
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
  try {
    await started;
    assert.equal((await get(`${p.url}/lodash`)).status, 200);
    assert.equal(responseStarted, false, 'even response headers must wait for approval');
    release();
    const res = await download;
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), tarballBytes);
  } finally { release(); await download; await p.close(); }
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
    assert.equal(res.headers['x-pkgxray-verdict'], 'scan-error');
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
      assert.equal(res.headers['x-pkgxray-verdict'], 'unbound');
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
