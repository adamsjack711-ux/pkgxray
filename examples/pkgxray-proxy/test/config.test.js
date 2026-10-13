import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, DEFAULTS } from '../src/config.js';

test('defaults apply with empty env', () => {
  const cfg = loadConfig({}, {});
  assert.equal(cfg.port, DEFAULTS.port);
  assert.equal(cfg.upstream, DEFAULTS.upstream);
  assert.equal(cfg.reviewPolicy, 'block');
  assert.equal(cfg.scanConcurrency, 4);
  assert.equal(cfg.maxPendingScans, 64);
  assert.equal(cfg.scanErrorPolicy, 'fail-closed');
});

test('env overrides defaults', () => {
  const cfg = loadConfig({}, {
    PKGXRAY_PROXY_PORT: '9999',
    PKGXRAY_PROXY_REVIEW_POLICY: 'block',
    PKGXRAY_CACHE_URL: 'http://cache.local:7000',
  });
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.reviewPolicy, 'block');
  assert.equal(cfg.cacheUrl, 'http://cache.local:7000');
});

test('precedence: overrides > env > file > defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-cfg-'));
  const file = join(dir, 'config.json');
  try {
    writeFileSync(file, JSON.stringify({ port: 1111, host: '0.0.0.0', reviewPolicy: 'allow' }));
    const env = { PKGXRAY_PROXY_CONFIG: file, PKGXRAY_PROXY_PORT: '2222' };
    const cfg = loadConfig({ reviewPolicy: 'block' }, env);
    assert.equal(cfg.port, 2222);       // env beats file
    assert.equal(cfg.host, '0.0.0.0');  // file beats default
    assert.equal(cfg.reviewPolicy, 'block'); // override beats env/file
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects invalid reviewPolicy', () => {
  assert.throws(() => loadConfig({ reviewPolicy: 'nonsense' }, {}), /reviewPolicy/);
});

test('rejects invalid scanErrorPolicy', () => {
  assert.throws(() => loadConfig({ scanErrorPolicy: 'maybe' }, {}), /scanErrorPolicy/);
});

test('rejects invalid port', () => {
  assert.throws(() => loadConfig({ port: 70000 }, {}), /port/);
  assert.throws(() => loadConfig({}, { PKGXRAY_PROXY_PORT: 'abc' }), /PKGXRAY_PROXY_PORT/);
});

test('rejects non-http upstream', () => {
  assert.throws(() => loadConfig({ upstream: 'ftp://x' }, {}), /upstream/);
});

test('rejects invalid scanTimeoutMs', () => {
  assert.throws(() => loadConfig({ scanTimeoutMs: 0 }, {}), /scanTimeoutMs/);
});

test('scan capacity is configurable but bounded', () => {
  const cfg = loadConfig({}, { PKGXRAY_PROXY_SCAN_CONCURRENCY: '2', PKGXRAY_PROXY_MAX_PENDING_SCANS: '0' });
  assert.equal(cfg.scanConcurrency, 2);
  assert.equal(cfg.maxPendingScans, 0);
  for (const scanConcurrency of [0, -1, 1.5, 33]) assert.throws(() => loadConfig({ scanConcurrency }, {}), /scanConcurrency/);
  for (const maxPendingScans of [-1, 1.5, 1025]) assert.throws(() => loadConfig({ maxPendingScans }, {}), /maxPendingScans/);
});

test('hold and error cache lifetimes have independent validated configuration', () => {
  const defaults = loadConfig({}, {});
  assert.equal(defaults.holdTtlMs, 300000);
  assert.equal(defaults.scanErrorTtlMs, 60000);
  const config = loadConfig({}, { PKGXRAY_PROXY_HOLD_TTL_MS: '0', PKGXRAY_PROXY_SCAN_ERROR_TTL_MS: '1200' });
  assert.equal(config.holdTtlMs, 0);
  assert.equal(config.scanErrorTtlMs, 1200);
  for (const field of ['holdTtlMs', 'scanErrorTtlMs']) {
    for (const value of [-1, 0.5, null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => loadConfig({ [field]: value }, {}), new RegExp(field));
    }
  }
});

test('adminToken defaults to undefined and is read from env', () => {
  assert.equal(loadConfig({}, {}).adminToken, undefined);
  assert.equal(loadConfig({}, { PKGXRAY_PROXY_ADMIN_TOKEN: 's3cret' }).adminToken, 's3cret');
});

test('rejects an empty adminToken', () => {
  assert.throws(() => loadConfig({ adminToken: '' }, {}), /adminToken/);
});

test('strips trailing slash from upstream', () => {
  const cfg = loadConfig({ upstream: 'https://registry.npmjs.org/' }, {});
  assert.equal(cfg.upstream, 'https://registry.npmjs.org');
});

test('parses comma-separated allow/denylist from env', () => {
  const cfg = loadConfig({}, {
    PKGXRAY_PROXY_ALLOWLIST: 'lodash, @babel/core',
    PKGXRAY_PROXY_DENYLIST: 'evil@1.0.0',
  });
  assert.deepEqual(cfg.allowlist, ['lodash', '@babel/core']);
  assert.deepEqual(cfg.denylist, ['evil@1.0.0']);
});

test('logDecisions honors falsey env strings', () => {
  assert.equal(loadConfig({}, { PKGXRAY_PROXY_LOG_DECISIONS: 'false' }).logDecisions, false);
  assert.equal(loadConfig({}, { PKGXRAY_PROXY_LOG_DECISIONS: '0' }).logDecisions, false);
  assert.equal(loadConfig({}, { PKGXRAY_PROXY_LOG_DECISIONS: 'yes' }).logDecisions, true);
});

test('throws on malformed config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-cfg-'));
  const file = join(dir, 'bad.json');
  try {
    writeFileSync(file, '{ not json');
    assert.throws(() => loadConfig({}, { PKGXRAY_PROXY_CONFIG: file }), /Invalid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
