import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gate } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { VerdictStore } from '../src/verdict-store.js';
import { ScanError } from '../src/pkgxray-runner.js';

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-gate-'));
  const config = loadConfig({ verdictStorePath: join(dir, 'v.json'), ...overrides }, {});
  const store = new VerdictStore(config.verdictStorePath);
  return { config, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A runner that records calls and returns a canned verdict (or throws).
function runnerReturning(result, spy) {
  return async (bin, ref, opts) => {
    if (spy) spy.push({ bin, ref, opts });
    if (result instanceof Error) throw result;
    return result;
  };
}

test('allow verdict serves 200 and caches', async () => {
  const { config, store, cleanup } = fixture();
  try {
    const spy = [];
    const runGuard = runnerReturning({ decision: 'allow', findings: [] }, spy);
    const d = await gate({ config, store, name: 'lodash', version: '4.17.21', runGuard });
    assert.equal(d.serve, true);
    assert.equal(d.status, 200);
    assert.equal(store.get('lodash', '4.17.21').decision, 'allow');
    assert.equal(spy.length, 1);
  } finally { cleanup(); }
});

test('block verdict returns 403 with findings and caches', async () => {
  const { config, store, cleanup } = fixture();
  try {
    const runGuard = runnerReturning({ decision: 'block', findings: [{ reason: 'exfil' }] });
    const d = await gate({ config, store, name: 'evil', version: '1.0.0', runGuard });
    assert.equal(d.serve, false);
    assert.equal(d.status, 403);
    assert.equal(d.findings[0].reason, 'exfil');
    assert.equal(store.get('evil', '1.0.0').decision, 'block');
  } finally { cleanup(); }
});

test('cache hit skips the scan', async () => {
  const { config, store, cleanup } = fixture();
  try {
    store.set('lodash', '4.17.21', 'allow', []);
    const spy = [];
    const runGuard = runnerReturning({ decision: 'block', findings: [] }, spy);
    const d = await gate({ config, store, name: 'lodash', version: '4.17.21', runGuard });
    assert.equal(d.serve, true);
    assert.equal(d.cached, true);
    assert.equal(spy.length, 0, 'runner must not be called on cache hit');
  } finally { cleanup(); }
});

test('denylist short-circuits to 403 without scanning', async () => {
  const { config, store, cleanup } = fixture({ denylist: ['evil'] });
  try {
    const spy = [];
    const runGuard = runnerReturning({ decision: 'allow', findings: [] }, spy);
    const d = await gate({ config, store, name: 'evil', version: '9.9.9', runGuard });
    assert.equal(d.serve, false);
    assert.equal(d.source, 'denylist');
    assert.equal(spy.length, 0);
    assert.equal(store.has('evil', '9.9.9'), false, 'denylist decisions are not cached');
  } finally { cleanup(); }
});

test('allowlist short-circuits to 200 without scanning', async () => {
  const { config, store, cleanup } = fixture({ allowlist: ['internal-pkg'] });
  try {
    const spy = [];
    const runGuard = runnerReturning(new ScanError('should not run'), spy);
    const d = await gate({ config, store, name: 'internal-pkg', version: '1.0.0', runGuard });
    assert.equal(d.serve, true);
    assert.equal(d.source, 'allowlist');
    assert.equal(spy.length, 0);
  } finally { cleanup(); }
});

test('allowlist supports name@version pinning', async () => {
  const { config, store, cleanup } = fixture({ allowlist: ['pkg@1.2.3'] });
  try {
    const runGuard = runnerReturning({ decision: 'block', findings: [] });
    const pinned = await gate({ config, store, name: 'pkg', version: '1.2.3', runGuard });
    assert.equal(pinned.serve, true);
    // A different version is NOT pinned and still gets scanned/blocked.
    const other = await gate({ config, store, name: 'pkg', version: '2.0.0', runGuard });
    assert.equal(other.serve, false);
  } finally { cleanup(); }
});

test('review + reviewPolicy=block returns 403', async () => {
  const { config, store, cleanup } = fixture({ reviewPolicy: 'block' });
  try {
    const runGuard = runnerReturning({ decision: 'review', findings: [{ reason: 'obfuscated' }] });
    const d = await gate({ config, store, name: 'sketchy', version: '1.0.0', runGuard });
    assert.equal(d.serve, false);
    assert.equal(d.status, 403);
    assert.equal(store.get('sketchy', '1.0.0').decision, 'review'); // still cached
  } finally { cleanup(); }
});

test('review + reviewPolicy=warn serves 200 with a note', async () => {
  const { config, store, cleanup } = fixture({ reviewPolicy: 'warn' });
  try {
    const runGuard = runnerReturning({ decision: 'review', findings: [] });
    const d = await gate({ config, store, name: 'sketchy', version: '1.0.0', runGuard });
    assert.equal(d.serve, true);
    assert.equal(d.decision, 'review');
    assert.match(d.note, /warn/);
  } finally { cleanup(); }
});

test('review + reviewPolicy=allow serves 200', async () => {
  const { config, store, cleanup } = fixture({ reviewPolicy: 'allow' });
  try {
    const runGuard = runnerReturning({ decision: 'review', findings: [] });
    const d = await gate({ config, store, name: 'sketchy', version: '1.0.0', runGuard });
    assert.equal(d.serve, true);
  } finally { cleanup(); }
});

test('scan error + fail-closed returns 403 and does NOT cache', async () => {
  const { config, store, cleanup } = fixture({ scanErrorPolicy: 'fail-closed' });
  try {
    const runGuard = runnerReturning(new ScanError('timed out', { timeout: true }));
    const d = await gate({ config, store, name: 'x', version: '1.0.0', runGuard });
    assert.equal(d.serve, false);
    assert.equal(d.status, 403);
    assert.equal(d.decision, 'scan-error');
    assert.equal(store.has('x', '1.0.0'), false);
  } finally { cleanup(); }
});

test('scan error + fail-open serves 200 and does NOT cache', async () => {
  const { config, store, cleanup } = fixture({ scanErrorPolicy: 'fail-open' });
  try {
    const runGuard = runnerReturning(new ScanError('spawn failed'));
    const d = await gate({ config, store, name: 'x', version: '1.0.0', runGuard });
    assert.equal(d.serve, true);
    assert.equal(d.decision, 'scan-error');
    assert.equal(store.has('x', '1.0.0'), false);
  } finally { cleanup(); }
});

test('forwards timeout + cacheUrl to the runner', async () => {
  const { config, store, cleanup } = fixture({ cacheUrl: 'http://cache:7000', scanTimeoutMs: 12345 });
  try {
    const spy = [];
    const runGuard = runnerReturning({ decision: 'allow', findings: [] }, spy);
    await gate({ config, store, name: 'lodash', version: '4.17.21', runGuard });
    assert.equal(spy[0].opts.cacheUrl, 'http://cache:7000');
    assert.equal(spy[0].opts.timeoutMs, 12345);
    assert.equal(spy[0].ref, 'lodash@4.17.21');
  } finally { cleanup(); }
});
