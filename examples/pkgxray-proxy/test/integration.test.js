import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { VerdictStore } from '../src/verdict-store.js';

// Opt-in end-to-end test against the REAL npm registry. Skipped unless
// PKGXRAY_PROXY_E2E=1. Requires network access; it always-allows via a stub
// runner so it exercises the real streaming path without needing pkgxray.
const enabled = process.env.PKGXRAY_PROXY_E2E === '1';

test('proxies a real tarball from registry.npmjs.org', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-e2e-'));
  const config = loadConfig(
    { upstream: 'https://registry.npmjs.org', verdictStorePath: join(dir, 'v.json'), logDecisions: false },
    {},
  );
  const store = new VerdictStore(config.verdictStorePath);
  // Stub runner: treat everything as allow so we test the network path only.
  const server = createServer(config, store, {
    runGuard: async () => ({ decision: 'allow', findings: [] }),
    log: () => {},
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = (path) => new Promise((resolve, reject) => {
    http.get(base + path, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  try {
    const meta = await get('/lodash');
    assert.equal(meta.status, 200);
    assert.equal(JSON.parse(meta.body.toString()).name, 'lodash');

    const tgz = await get('/lodash/-/lodash-4.17.21.tgz');
    assert.equal(tgz.status, 200);
    assert.equal(tgz.headers['x-pkgxray-verdict'], 'allow');
    // A real lodash tarball is a gzip stream (~0x1f 0x8b) of nontrivial size.
    assert.ok(tgz.body.length > 1000, 'expected a real tarball payload');
    assert.equal(tgz.body[0], 0x1f);
    assert.equal(tgz.body[1], 0x8b);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
