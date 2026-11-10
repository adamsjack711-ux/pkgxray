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
import reviews from '../../../src/review.js';
import policy from '../../../src/config.js';

for (const callers of [4, 5]) test(`${callers} developers share one scan, never approvals`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-team-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'held.tgz');
  await writeFile(file, 'review artifact');
  let snapshot = { file, sha256: crypto.createHash('sha256').update('review artifact').digest('hex') };
  const config = loadConfig({ reviewPolicy: 'allow', verdictStorePath: join(dir, 'store.json') }, {});
  const store = new VerdictStore(config.verdictStorePath), decisions = new reviews.ReviewDecisions();
  let scans = 0, sharedPolicy = policy.DEFAULTS;
  const runGuard = (...args) => withReceipt(async () => {
    scans++; await new Promise(resolve => setTimeout(resolve, 10));
    return { decision: 'review', findings: [{ reason: 'fixture evidence' }] };
  }, sharedPolicy)(...args);
  const check = scope => gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, runGuard, sharedPolicy, scope, decisions });
  const pending = await Promise.all(Array.from({ length: callers }, (_, i) => check(`dev${i}`)));
  assert.equal(scans, 1);
  for (const p of pending) { assert.equal(p.serve, false); assert.equal(p.outcome, null); assert.equal(p.review.state, 'pending'); assert.equal(p.findings[0].reason, 'fixture evidence'); }
  assert.throws(() => decisions.choose('unseen', pending[0].review.id, 'Proceed'));
  assert.throws(() => decisions.choose('dev0', pending[0].review.id, 'yes'));
  decisions.choose('dev0', pending[0].review.id, 'Proceed');
  decisions.choose('dev1', pending[1].review.id, 'Decline');
  for (let i = 0; i < 2; i++) {
    const approved = await check('dev0');
    assert.equal(approved.serve, true); assert.equal(approved.outcome, 'SAFE'); assert.equal(approved.review.requiresDecision, false);
    const declined = await check('dev1');
    assert.equal(declined.serve, false); assert.equal(declined.outcome, 'UNSAFE'); assert.equal(declined.review.requiresDecision, false);
    assert.equal((await check('dev2')).review.state, 'pending');
  }
  assert.equal(scans, 1);
  assert.equal(store.get('demo', '1.0.0').decision, 'review');
  assert.ok(!JSON.stringify(store.get('demo', '1.0.0')).includes('Proceed'));
  const firstId = pending[0].review.id;
  sharedPolicy = { ...sharedPolicy, policy: 'allow-review' };
  assert.equal((await check('dev0')).review.state, 'pending'); assert.equal(scans, 2);
  await writeFile(file, 'changed artifact');
  snapshot = { file, sha256: crypto.createHash('sha256').update('changed artifact').digest('hex') };
  const changed = await check('dev0');
  assert.equal(changed.review.state, 'pending'); assert.notEqual(changed.review.id, firstId); assert.equal(scans, 3);
  const receipt = store.get('demo', '1.0.0').binding.approval;
  assert.notEqual(reviews.reviewIdentity(receipt), reviews.reviewIdentity({ ...receipt, scannerBuildId: 'new-ruleset' }));
  const reload = new VerdictStore(config.verdictStorePath);
  const freshSession = await gateArtifact({ config, store: reload, name: 'demo', version: '1.0.0', snapshot, runGuard, sharedPolicy, scope: 'new', decisions });
  assert.equal(freshSession.review.state, 'pending'); assert.equal(scans, 3);
});
