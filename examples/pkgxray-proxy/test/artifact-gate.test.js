import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { gateArtifact } from '../src/artifact-gate.js';
import { createScanCoordinator } from '../src/scan-coordinator.js';
import { VerdictStore } from '../src/verdict-store.js';
import { loadConfig } from '../src/config.js';
import { withReceipt } from './receipt-helper.js';
import policy from '../../../src/config.js';
import { adminRecheck } from '../src/proxy.js';
import { createRequire } from 'node:module';
const { MANDATORY_CATEGORIES } = createRequire(import.meta.url)('../../../src/approval-policy.js');

test('concurrent identical artifacts share a scan; cached approvals bypass occupied scan slots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-shared-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'held.tgz');
  await writeFile(file, 'benign fixture');
  const snapshot = { file, sha256: crypto.createHash('sha256').update('benign fixture').digest('hex') };
  const config = loadConfig({ verdictStorePath: join(dir, 'store.json') }, {});
  const store = new VerdictStore(config.verdictStorePath);
  const scanCoordinator = createScanCoordinator({ concurrency: 1, maxPending: 0 });
  let release, scans = 0;
  const held = new Promise(resolve => { release = resolve; });
  const runGuard = withReceipt(async () => { scans++; await held; return { decision: 'allow', findings: [] }; });
  const check = (extra = {}) => gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, runGuard, scanCoordinator, ...extra });
  const requests = [check(), check(), check()];
  release();
  assert.ok((await Promise.all(requests)).every(result => result.serve));
  assert.equal(scans, 1);

  let finish;
  const occupied = scanCoordinator.run('other-artifact', () => new Promise(resolve => { finish = resolve; }));
  try {
    const cached = await check();
    assert.equal(cached.source, 'cache');
    assert.equal(cached.serve, true);
    const changed = await check({ version: '1.0.1' });
    assert.equal(changed.serve, false);
    assert.match(changed.note, /queue is full/);
    assert.equal(scans, 1);
  } finally { finish(); await occupied; }
});

test('scan sharing separates artifact bytes, package identity and policy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-scan-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ verdictStorePath: join(dir, 'store.json') }, {});
  const store = new VerdictStore(config.verdictStorePath);
  const keys = [];
  const scanCoordinator = { run(key, scan) { keys.push(key); return scan(); } };
  for (const [i, extra] of [{}, { name: 'other' }, { version: '2.0.0' },
    { sharedPolicy: { ...policy.DEFAULTS, policy: 'allow-review' } }, { bytes: 'different fixture' }].entries()) {
    const file = join(dir, `${i}.tgz`), bytes = extra.bytes || 'benign fixture';
    await writeFile(file, bytes);
    const snapshot = { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const runGuard = withReceipt(async () => ({ decision: 'allow', findings: [] }), extra.sharedPolicy || policy.DEFAULTS);
    const result = await gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, runGuard, scanCoordinator, ...extra });
    assert.equal(result.serve, true);
  }
  assert.equal(new Set(keys).size, 5);
});

test('policy changes and invalid persisted build receipts force rescanning', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'held.tgz');
  await writeFile(file, 'held artifact');
  const snapshot = { file, sha256: crypto.createHash('sha256').update('held artifact').digest('hex') };
  const config = loadConfig({ verdictStorePath: join(dir, 'store.json') }, {});
  let store = new VerdictStore(config.verdictStorePath);
  let scans = 0;
  let sharedPolicy = policy.DEFAULTS;
  const runGuard = (...args) => withReceipt(async () => { scans++; return { decision: 'allow', findings: [] }; }, sharedPolicy)(...args);
  const check = () => gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, runGuard, sharedPolicy });
  assert.equal((await check()).serve, true);
  store = new VerdictStore(config.verdictStorePath);
  assert.equal((await check()).source, 'cache');
  assert.equal(scans, 1);
  sharedPolicy = { ...policy.DEFAULTS, policy: 'allow-review' };
  assert.equal((await check()).source, 'scan');
  assert.equal(scans, 2);
  const cached = store.get('demo', '1.0.0');
  cached.binding.approval.scannerBuildId = 'retired-build';
  assert.equal((await check()).source, 'scan');
  assert.equal(scans, 3);
});

test('fresh and restarted mandatory holds never become discretionary reviews', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-hold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'held.tgz');
  await writeFile(file, 'benign fixture');
  const snapshot = { file, sha256: crypto.createHash('sha256').update('benign fixture').digest('hex') };
  for (const reviewPolicy of ['warn', 'allow', 'block']) {
    for (const category of MANDATORY_CATEGORIES) {
      const config = loadConfig({ reviewPolicy, verdictStorePath: join(dir, `${reviewPolicy}-${category}.json`) }, {});
      let store = new VerdictStore(config.verdictStorePath);
      const check = runGuard => gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, runGuard });
      const valid = withReceipt(async () => ({ decision: 'allow', findings: [] }));
      assert.equal((await check(valid)).serve, true);
      // A legacy approval with incomplete coverage cannot be reused.
      const authorization = { mandatoryHoldReasons: [category], behavioralCoverage: 'partial', explicitOverride: false };
      store.get('demo', '1.0.0').binding.approval.authorization = authorization;
      let scans = 0;
      const freshHold = async (...args) => {
        scans++;
        const scan = await withReceipt(async () => ({ decision: 'review', findings: [{ category }] }))(...args);
        scan.approval.authorization = authorization;
        return scan;
      };
      for (const source of ['scan', 'cache']) {
        const result = await check(freshHold);
        assert.equal(result.serve, false);
        assert.equal(result.decision, 'unbound');
        assert.equal(result.source, source);
        assert.deepEqual(result.findings, [{ category }]);
        assert.equal(store.get('demo', '1.0.0'), undefined, 'hold retires old approval');
        store = new VerdictStore(config.verdictStorePath);
      }
      assert.equal(scans, 1, 'deny-only cache avoids repeating an unresolved scan');
    }
  }
});

async function holdFixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-hold-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'held.tgz');
  await writeFile(file, 'benign fixture');
  const config = loadConfig({ verdictStorePath: join(dir, 'store.json'), ...overrides }, {});
  const clock = { now: 1000 };
  const store = new VerdictStore(config.verdictStorePath, { now: () => clock.now });
  const snapshot = { file, sha256: crypto.createHash('sha256').update('benign fixture').digest('hex') };
  let scans = 0;
  const args = { config, store, name: 'demo', version: '1.0.0', snapshot,
    runGuard: async () => { scans++; return { decision: 'review', findings: [{ category: 'incomplete-source-scan' }] }; } };
  return { args, clock, scans: () => scans, check: extra => gateArtifact({ ...args, ...extra }) };
}

test('hold cache invalidates for changed bytes, identity, scanner context and policy', async t => {
  const f = await holdFixture(t);
  assert.equal((await f.check()).source, 'scan');
  assert.equal((await f.check()).source, 'cache');
  for (const extra of [
    { snapshot: { ...f.args.snapshot, sha256: 'b'.repeat(64) } },
    { name: 'other' }, { version: '2.0.0' },
    { sharedPolicy: { ...policy.DEFAULTS, policy: 'allow-review' } },
    { config: { ...f.args.config, reviewPolicy: 'allow' } },
    { config: { ...f.args.config, scanTimeoutMs: 40000 } },
  ]) {
    const result = await f.check(extra);
    assert.equal(result.source, 'scan');
    assert.equal(result.serve, false);
  }
  const hold = f.args.store.getHold('demo', '1.0.0');
  hold.binding.context = 'old-scanner-build-context';
  assert.equal((await f.check()).source, 'scan');
  assert.equal(f.scans(), 8);
});

test('hold expiry, clock rollback and zero TTL force fresh scans', async t => {
  for (const overrides of [{ holdTtlMs: 50 }, { holdTtlMs: 0 }, { verdictTtlMs: 0 }]) {
    const f = await holdFixture(t, overrides);
    await f.check();
    if (overrides.holdTtlMs === 50) {
      f.clock.now += 49;
      assert.equal((await f.check()).source, 'cache');
      f.clock.now++;
    }
    assert.equal((await f.check()).source, 'scan');
    f.clock.now--;
    assert.equal((await f.check()).source, 'scan', 'future-dated holds are stale');
  }
});

test('scanner failures back off, then retry without falling back to stale approvals', async t => {
  const f = await holdFixture(t, { verdictTtlMs: 100, scanErrorTtlMs: 50 });
  const approved = withReceipt(async () => ({ decision: 'allow', findings: [] }));
  assert.equal((await f.check({ runGuard: approved })).serve, true);
  f.clock.now += 100;
  let failures = 0;
  const fail = async () => { failures++; throw new Error('temporary scan timeout'); };
  for (const source of ['scan', 'cache']) {
    const result = await f.check({ runGuard: fail });
    assert.equal(result.serve, false);
    assert.equal(result.source, source);
    assert.equal(result.decision, 'scan-error');
  }
  assert.equal(failures, 1);
  assert.equal(f.args.store.get('demo', '1.0.0'), undefined);
  f.clock.now += 50;
  assert.equal((await f.check({ runGuard: approved })).serve, true);
  assert.equal(f.args.store.getHold('demo', '1.0.0'), undefined);
  assert.equal((await f.check()).serve, true, 'fresh bound approval replaces expired failure');
});

test('cached holds bypass occupied scan slots; queue pressure does not persist as a hold', async t => {
  const f = await holdFixture(t);
  await f.check();
  const scanCoordinator = createScanCoordinator({ concurrency: 1, maxPending: 0 });
  let finish;
  const occupied = scanCoordinator.run('occupied', () => new Promise(resolve => { finish = resolve; }));
  try {
    const result = await f.check({ scanCoordinator });
    assert.equal(result.source, 'cache');
    assert.equal(result.serve, false);
    const busy = await f.check({ scanCoordinator, name: 'other' });
    assert.match(busy.note, /queue is full/);
    assert.equal(f.args.store.getHold('other', '1.0.0'), undefined);
  } finally { finish(); await occupied; }
  assert.equal((await f.check({ scanCoordinator, name: 'other' })).source, 'scan');
});

test('zero error TTL retries immediately while ordinary holds remain reusable', async t => {
  const f = await holdFixture(t, { scanErrorTtlMs: 0 });
  let attempts = 0;
  const runGuard = async () => { attempts++; throw new Error('temporary failure'); };
  for (let i = 0; i < 2; i++) {
    const result = await f.check({ runGuard });
    assert.equal(result.source, 'scan');
    assert.equal(result.serve, false);
  }
  assert.equal(attempts, 2);
  assert.equal((await f.check()).source, 'scan');
  assert.equal((await f.check()).source, 'cache');
});

test('admin refresh includes held packages and successful recheck requires a new artifact approval', async t => {
  const f = await holdFixture(t);
  await f.check();
  const failed = await adminRecheck({ ...f.args, runGuard: async () => { throw new Error('offline'); } });
  assert.equal(failed.total, 1);
  assert.equal(failed.errors.length, 1);
  assert.equal((await f.check()).source, 'cache');
  const refreshed = await adminRecheck({ ...f.args, runGuard: async () => ({ decision: 'allow', findings: [] }) });
  assert.equal(refreshed.total, 1);
  assert.equal(f.args.store.getHold('demo', '1.0.0'), undefined);
  const result = await f.check();
  assert.equal(result.source, 'scan', 'name/version recheck is not an artifact approval');
  assert.equal(result.serve, false);
});

test('requiring verified provenance retires cached permissive approvals', async t => {
  const previous = process.env.PKGXRAY_REQUIRE_PROVENANCE;
  delete process.env.PKGXRAY_REQUIRE_PROVENANCE;
  t.after(() => {
    if (previous === undefined) delete process.env.PKGXRAY_REQUIRE_PROVENANCE;
    else process.env.PKGXRAY_REQUIRE_PROVENANCE = previous;
  });
  const f = await holdFixture(t, { holdTtlMs: 0 });
  let scans = 0;
  const approved = withReceipt(async () => { scans++; return { decision: 'allow', findings: [] }; });
  assert.equal((await f.check({ runGuard: approved })).serve, true);
  assert.equal((await f.check({ runGuard: approved })).source, 'cache');
  process.env.PKGXRAY_REQUIRE_PROVENANCE = '1';
  const required = await f.check({ runGuard: approved });
  assert.equal(required.serve, false);
  assert.equal(required.source, 'scan');
  assert.equal(scans, 2);
  assert.equal(f.args.store.get('demo', '1.0.0'), undefined);
  const verified = async (...args) => {
    const result = await approved(...args);
    result.approval.checks.provenance = 'verified';
    return result;
  };
  assert.equal((await f.check({ runGuard: verified })).serve, true);
});

test('unknown scanner decisions never release bytes even with an otherwise valid receipt', async t => {
  const f = await holdFixture(t, { reviewPolicy: 'allow', holdTtlMs: 0 });
  for (const decision of ['unknown', '', null, 'SAFE']) {
    const runGuard = async (...args) => {
      const result = await withReceipt(async () => ({ decision: 'allow', findings: [] }))(...args);
      return { ...result, decision };
    };
    const result = await f.check({ runGuard });
    assert.equal(result.serve, false);
    assert.equal(result.decision, 'unbound');
  }
});
