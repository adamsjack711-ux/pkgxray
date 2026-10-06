import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { gateArtifact } from '../src/artifact-gate.js';
import { VerdictStore } from '../src/verdict-store.js';
import { loadConfig } from '../src/config.js';
import { withReceipt } from './receipt-helper.js';
import policy from '../../../src/config.js';
import { createRequire } from 'node:module';
const { MANDATORY_CATEGORIES } = createRequire(import.meta.url)('../../../src/approval-policy.js');

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

test('fresh and cached mandatory holds never become discretionary reviews', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-hold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'held.tgz');
  await writeFile(file, 'benign fixture');
  const snapshot = { file, sha256: crypto.createHash('sha256').update('benign fixture').digest('hex') };
  for (const reviewPolicy of ['warn', 'allow', 'block']) {
    const config = loadConfig({ reviewPolicy, verdictStorePath: join(dir, `${reviewPolicy}.json`) }, {});
    const store = new VerdictStore(config.verdictStorePath);
    const valid = withReceipt(async () => ({ decision: 'review', findings: [] }));
    const check = runGuard => gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, runGuard });
    assert.equal((await check(valid)).serve, reviewPolicy !== 'block', 'ordinary review remains discretionary');
    for (const category of MANDATORY_CATEGORIES) {
      const cached = store.get('demo', '1.0.0');
      cached.binding.approval.authorization = { mandatoryHoldReasons: [category], behavioralCoverage: 'partial', explicitOverride: false };
      let scanned = false;
      const freshHold = async (...args) => {
        scanned = true;
        const scan = await valid(...args);
        scan.approval.authorization = cached.binding.approval.authorization;
        return scan;
      };
      assert.equal((await check(freshHold)).serve, false);
      assert.equal(scanned, true, 'cached mandatory hold cannot authorize serving');
    }
    const cached = store.get('demo', '1.0.0'); cached.binding.approval.schemaVersion = 1;
    assert.equal((await check(async () => ({ decision: 'review', approval: cached.binding.approval }))).serve, false);
  }
});
