import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gate, adminRecheck } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { VerdictStore } from '../src/verdict-store.js';
import { ScanError } from '../src/pkgxray-runner.js';

// Fixture with an injectable clock so TTL/staleness is deterministic.
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-refresh-'));
  const config = loadConfig({ verdictStorePath: join(dir, 'v.json'), ...overrides }, {});
  const clock = { t: 1000 };
  const store = new VerdictStore(config.verdictStorePath, { now: () => clock.t });
  return { config, store, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runner(result, spy) {
  return async (bin, ref, opts) => {
    if (spy) spy.push({ ref });
    if (result instanceof Error) throw result;
    return result;
  };
}

// --- VerdictStore.isStale / entries -----------------------------------------

test('isStale: fresh within TTL, stale beyond it, missing ts always stale', () => {
  const { store, clock, cleanup } = fixture();
  try {
    clock.t = 1000;
    store.set('a', '1.0.0', 'allow', []); // ts = 1000
    clock.t = 5000;
    const entry = store.get('a', '1.0.0');
    assert.equal(store.isStale(entry, 10000), false, 'age 4000 < ttl 10000 => fresh');
    assert.equal(store.isStale(entry, 1000), true, 'age 4000 > ttl 1000 => stale');
    assert.equal(store.isStale(entry, undefined), false, 'no TTL => never stale');
    assert.equal(store.isStale({ decision: 'allow', findings: [], ts: 0 }, 10000), true, 'ts=0 always stale');
    assert.equal(store.isStale(undefined, 10000), true);
  } finally { cleanup(); }
});

test('entries() snapshots name/version/decision, scoped names included', () => {
  const { store, cleanup } = fixture();
  try {
    store.set('lodash', '4.17.21', 'allow', []);
    store.set('@scope/pkg', '2.0.0', 'block', [{ reason: 'x' }]);
    const es = store.entries().sort((a, b) => a.name.localeCompare(b.name));
    assert.equal(es.length, 2);
    assert.deepEqual({ name: es[0].name, version: es[0].version, decision: es[0].decision },
      { name: '@scope/pkg', version: '2.0.0', decision: 'block' });
  } finally { cleanup(); }
});

// --- gate TTL-based lazy refresh --------------------------------------------

test('a fresh verdict serves from cache without a rescan', async () => {
  const { config, store, clock, cleanup } = fixture({ verdictTtlMs: 10000 });
  try {
    clock.t = 1000;
    store.set('lodash', '4.17.21', 'allow', []);
    clock.t = 2000; // age 1000 < ttl 10000
    const spy = [];
    const d = await gate({ config, store, name: 'lodash', version: '4.17.21', runGuard: runner({ decision: 'block', findings: [] }, spy) });
    assert.equal(spy.length, 0, 'no rescan for a fresh entry');
    assert.equal(d.serve, true);
    assert.equal(d.source, 'cache');
  } finally { cleanup(); }
});

test('a verdict older than TTL triggers exactly one rescan', async () => {
  const { config, store, clock, cleanup } = fixture({ verdictTtlMs: 500 });
  try {
    clock.t = 1000;
    store.set('lodash', '4.17.21', 'allow', []);
    clock.t = 2000; // age 1000 > ttl 500 => stale
    const spy = [];
    await gate({ config, store, name: 'lodash', version: '4.17.21', runGuard: runner({ decision: 'allow', findings: [] }, spy) });
    assert.equal(spy.length, 1, 'stale entry re-scanned once');
  } finally { cleanup(); }
});

test('a regression on refresh flips subsequent decisions to block and logs the transition', async () => {
  const { config, store, clock, cleanup } = fixture({ verdictTtlMs: 500 });
  try {
    clock.t = 1000;
    store.set('x', '1.0.0', 'allow', []);
    clock.t = 2000; // stale
    const logs = [];
    const d = await gate({
      config, store, name: 'x', version: '1.0.0',
      runGuard: runner({ decision: 'block', findings: [{ reason: 'now malicious' }] }),
      log: (e) => logs.push(e),
    });
    assert.equal(d.serve, false, 'refresh returns the new block decision');
    assert.equal(d.decision, 'block');
    assert.equal(store.get('x', '1.0.0').decision, 'block', 'store updated so future requests are gated');

    // The transition is in the structured log with from/to.
    const t = logs.find((e) => e.event === 'verdict-transition');
    assert.ok(t, 'transition logged');
    assert.equal(t.from, 'allow');
    assert.equal(t.to, 'block');

    // A subsequent request now serves the block from cache.
    clock.t = 2100;
    const d2 = await gate({ config, store, name: 'x', version: '1.0.0', runGuard: runner({ decision: 'allow', findings: [] }) });
    assert.equal(d2.decision, 'block');
    assert.equal(d2.source, 'cache');
  } finally { cleanup(); }
});

test('a failed refresh leaves the prior good verdict intact and serves it', async () => {
  const { config, store, clock, cleanup } = fixture({ verdictTtlMs: 500 });
  try {
    clock.t = 1000;
    store.set('y', '1.0.0', 'allow', [{ reason: 'clean' }]);
    clock.t = 2000; // stale
    const d = await gate({
      config, store, name: 'y', version: '1.0.0',
      runGuard: runner(new ScanError('registry 503')),
    });
    assert.equal(d.serve, true, 'served rather than degraded to a 403');
    assert.equal(d.decision, 'allow');
    assert.equal(d.source, 'cache');
    const entry = store.get('y', '1.0.0');
    assert.equal(entry.decision, 'allow', 'stored verdict untouched');
    assert.equal(entry.ts, 1000, 'ts not advanced by a failed refresh');
  } finally { cleanup(); }
});

// --- adminRecheck ------------------------------------------------------------

test('adminRecheck flips changed verdicts, keeps unchanged, never overwrites on error', async () => {
  const { config, store, cleanup } = fixture();
  try {
    store.set('a', '1.0.0', 'allow', []);   // will regress -> block
    store.set('b', '1.0.0', 'block', []);   // stays block
    store.set('c', '1.0.0', 'allow', []);   // rescan errors -> keep allow

    const fresh = { 'a@1.0.0': 'block', 'b@1.0.0': 'block' };
    const runGuard = async (bin, ref) => {
      if (ref === 'c@1.0.0') throw new ScanError('timeout');
      return { decision: fresh[ref], findings: [] };
    };
    const logs = [];
    const summary = await adminRecheck({ config, store, runGuard, log: (e) => logs.push(e) });

    assert.equal(summary.total, 3);
    assert.equal(summary.changed.length, 1);
    assert.deepEqual(summary.changed[0], { name: 'a', version: '1.0.0', from: 'allow', to: 'block' });
    assert.equal(summary.unchanged, 1);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].name, 'c');

    assert.equal(store.get('a', '1.0.0').decision, 'block', 'regressed verdict persisted');
    assert.equal(store.get('c', '1.0.0').decision, 'allow', 'errored re-scan left good verdict intact');
    assert.ok(logs.some((e) => e.event === 'verdict-transition' && e.reason === 'admin-recheck'));
  } finally { cleanup(); }
});
