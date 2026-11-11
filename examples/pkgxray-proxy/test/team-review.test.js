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

for (const callers of [4, 5]) test(`${callers} developers share one scan and the same binary denial`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-team-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'held.tgz');
  await writeFile(file, 'uncertain artifact');
  let snapshot = { file, sha256: crypto.createHash('sha256').update('uncertain artifact').digest('hex') };
  const config = loadConfig({ reviewPolicy: 'allow', verdictStorePath: join(dir, 'store.json') }, {});
  let store = new VerdictStore(config.verdictStorePath);
  let scans = 0, sharedPolicy = policy.DEFAULTS;
  const runGuard = (...args) => withReceipt(async () => {
    scans++; await new Promise(resolve => setTimeout(resolve, 10));
    return { decision: 'review', findings: [{ reason: 'fixture uncertainty' }] };
  }, sharedPolicy)(...args);
  const check = scope => gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, runGuard, sharedPolicy,
    scope, decisions: { present() { throw new Error('manual decision path must never be used'); } } });
  const results = await Promise.all(Array.from({ length: callers }, (_, i) => check(`dev${i}`)));
  assert.equal(scans, 1);
  for (const result of results) {
    assert.equal(result.serve, false); assert.equal(result.outcome, 'UNSAFE');
    assert.equal(result.decision, 'block'); assert.equal(result.status, 403);
    assert.equal(result.review, undefined); assert.equal(result.findings[0].reason, 'fixture uncertainty');
    assert.match(result.note, /not a finding of confirmed malware/);
  }
  assert.equal((await check('legacy-approved-user')).serve, false);
  assert.equal(scans, 1, 'finding-bearing reports are not retried');
  store = new VerdictStore(config.verdictStorePath);
  assert.equal((await check('new-user')).source, 'cache');
  assert.equal(scans, 1);
  sharedPolicy = { ...sharedPolicy, policy: 'legacy-different-policy' };
  assert.equal((await check('dev0')).serve, false); assert.equal(scans, 2);
  await writeFile(file, 'changed artifact');
  snapshot = { file, sha256: crypto.createHash('sha256').update('changed artifact').digest('hex') };
  assert.equal((await check('dev0')).serve, false); assert.equal(scans, 3);
});
