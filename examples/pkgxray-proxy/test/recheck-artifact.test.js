import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { gateArtifact, assertArtifactCurrent } from '../src/artifact-gate.js';
import { adminRecheck } from '../src/proxy.js';
import { VerdictStore } from '../src/verdict-store.js';
import { loadConfig } from '../src/config.js';
import { withReceipt } from './receipt-helper.js';
import policy from '../../../src/config.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-recheck-artifact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'inert.tgz');
  await writeFile(file, 'inert artifact');
  const snapshot = { file, sha256: crypto.createHash('sha256').update('inert artifact').digest('hex') };
  const config = loadConfig({ verdictStorePath: join(dir, 'store.json') }, {});
  const store = new VerdictStore(config.verdictStorePath);
  const runGuard = withReceipt(async () => ({ decision: 'allow', findings: [] }));
  const check = (opts = {}) => gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, runGuard,
    sharedPolicy: policy.DEFAULTS, ...opts });
  return { config, store, check };
}

test('admin BLOCK revokes cached approval, survives restart, and needs a later recheck to clear', async t => {
  const { config, store, check } = await setup(t);
  const approved = await check(); assert.equal(approved.serve, true);
  await adminRecheck({ config, store, runGuard: async () => ({ decision: 'block', findings: [{ reason: 'new evidence' }] }) });
  for (const cache of [store, new VerdictStore(config.verdictStorePath)]) {
    const denied = await check({ store: cache }); assert.equal(denied.serve, false); assert.equal(denied.decision, 'block');
  }
  assert.throws(() => assertArtifactCurrent(store, 'demo', '1.0.0', approved.recheckRevision), { code: 'RECHECK_CHANGED' });
  await adminRecheck({ config, store, runGuard: async () => ({ decision: 'allow', findings: [] }) });
  const fresh = await check(); assert.equal(fresh.serve, true); assert.equal(fresh.source, 'scan');
});

test('recheck findings invalidate approvals without any manual session decision', async t => {
  const { config, store, check } = await setup(t);
  assert.equal((await check()).serve, true);
  await adminRecheck({ config, store, runGuard: async () => ({ decision: 'allow', findings: [] }) });
  const unchanged = await check(); assert.equal(unchanged.serve, true); assert.equal(unchanged.source, 'scan');
  await adminRecheck({ config, store, runGuard: async () => ({ decision: 'block', findings: [{ reason: 'unresolved uncertainty' }] }) });
  for (const cache of [store, new VerdictStore(config.verdictStorePath)]) {
    const denied = await check({ store: cache });
    assert.equal(denied.serve, false); assert.equal(denied.outcome, 'UNSAFE'); assert.equal(denied.review, undefined);
  }
});

test('a scan started before recheck cannot refill the cache or authorize delivery', async t => {
  const { config, store, check } = await setup(t);
  store.set('demo', '1.0.0', 'review', []);
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const runner = withReceipt(async () => { started(); await new Promise(resolve => { release = resolve; }); return { decision: 'allow', findings: [] }; });
  const inFlight = check({ runGuard: runner }); await waiting;
  await adminRecheck({ config, store, runGuard: async () => ({ decision: 'block', findings: [] }) });
  release();
  assert.equal((await inFlight).serve, false);
  assert.equal(store.get('demo', '1.0.0').decision, 'block');
  assert.equal([...store._map.keys()].filter(k => k.startsWith('artifact:')).length, 0);
  assert.equal((await check()).serve, false);
});

test('cancelling the first proxy waiter does not cancel evidence needed by another session', async t => {
  const { check } = await setup(t);
  let release, started, scans = 0;
  const waiting = new Promise(resolve => { started = resolve; });
  const runner = withReceipt(async () => { scans++; started(); await new Promise(resolve => { release = resolve; }); return { decision: 'review', findings: [] }; });
  const controller = new AbortController();
  const a = check({ runGuard: runner, signal: controller.signal });
  const b = check({ runGuard: runner, scope: 'B' });
  await waiting; controller.abort();
  assert.equal((await a).serve, false);
  release();
  const pendingB = await b;
  assert.equal(scans, 1);
  assert.equal(pendingB.decision, 'block'); assert.equal(pendingB.review, undefined); assert.equal(pendingB.serve, false);
});
