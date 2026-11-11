import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { VerdictStore } from '../src/verdict-store.js';
import { withReceipt } from './receipt-helper.js';
import policy from '../../../src/config.js';

async function fixture(t, initial = { typosquat: false }) {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-policy-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policyPath = join(dir, '.pkgxray.json');
  await writeFile(policyPath, JSON.stringify(initial));
  const bytes = Buffer.from('held artifact fixture; never executed');
  const upstream = http.createServer((req, res) => res.end(bytes));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const config = loadConfig({ upstream: `http://127.0.0.1:${upstream.address().port}`,
    policyCwd: dir, verdictStorePath: join(dir, 'verdicts.json'), logDecisions: false }, {});
  const store = new VerdictStore(config.verdictStorePath);
  const state = { scans: 0, onScan: async () => {}, onDecision: () => {}, decision: 'allow' };
  const server = createServer(config, store, {
    // Intentionally no sharedPolicy injection: use the production disk policy.
    runGuard: async (...args) => {
      const scannedPolicy = policy.loadConfig({ cwd: dir }).config;
      return withReceipt(async () => {
        state.scans++;
        await state.onScan();
        return { decision: state.decision, findings: [] };
      }, scannedPolicy)(...args);
    },
    log: event => { if (event.event === 'decision') state.onDecision(event); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = () => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/demo/-/demo-1.0.0.tgz`, { agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  return { dir, policyPath, bytes, state, get, store };
}

const changes = [
  ['check setting', f => writeFileSync(f.policyPath, JSON.stringify({ typosquat: true }))],
  ['mute rule', f => writeFileSync(f.policyPath, JSON.stringify({ mute: [{ check: 'install-hook', scope: '*', reason: 'operator policy' }] }))],
  ['pinned allow rule', f => writeFileSync(f.policyPath, JSON.stringify({ allow: [{ pkg: 'demo@1.0.0', sha256: 'a'.repeat(64), reason: 'operator policy' }] }))],
  ['file disappearance with identical effective defaults', f => unlinkSync(f.policyPath), {}],
  ['malformed file with identical effective defaults', f => writeFileSync(f.policyPath, '{broken'), {}],
  ['local override', f => writeFileSync(join(f.dir, '.pkgxray.local.json'), JSON.stringify({ typosquat: true }))]
];

for (const phase of ['scan', 'delivery']) {
  test(`policy changes at ${phase} commit prevent held artifact delivery`, async t => {
    for (const [name, mutate, initial] of changes) {
      await t.test(name, async t => {
        const f = await fixture(t, initial);
        if (phase === 'scan') f.state.onScan = () => mutate(f);
        else f.state.onDecision = () => mutate(f);
        const result = await f.get();
        assert.equal(result.status, phase === 'scan' ? 403 : 503);
        assert.equal(result.headers['x-pkgxray-verdict'], 'UNSAFE');
        assert.notDeepEqual(result.body, f.bytes, 'no held artifact bytes may reach the client');
        const response = JSON.parse(result.body);
        assert.equal(response.reasonCode || response.error, 'POLICY_CHANGED');
        if (phase === 'scan') assert.equal(f.store.get('demo', '1.0.0'), undefined, 'changed policy cannot cache authorization');
      });
    }
  });
}

test('unchanged policy reuses a bound approval; a changed policy cannot reuse it', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.get()).body, f.bytes);
  const cached = await f.get();
  assert.equal(cached.status, 200);
  assert.equal(cached.headers['x-pkgxray-source'], 'cache');
  assert.deepEqual(cached.body, f.bytes);
  assert.equal(f.state.scans, 1);
  await writeFile(f.policyPath, JSON.stringify({ typosquat: true }));
  f.state.decision = 'block';
  const changed = await f.get();
  assert.equal(changed.status, 403);
  assert.notDeepEqual(changed.body, f.bytes);
  assert.equal(f.state.scans, 2, 'new policy requires new evidence rather than cached allow');
});

test('cached approval is revalidated after logging and immediately before delivery', async t => {
  const f = await fixture(t);
  assert.equal((await f.get()).status, 200);
  f.state.onDecision = event => {
    assert.equal(event.source, 'cache');
    writeFileSync(f.policyPath, JSON.stringify({ typosquat: true }));
  };
  const result = await f.get();
  assert.equal(result.status, 503);
  assert.notDeepEqual(result.body, f.bytes);
  assert.equal(JSON.parse(result.body).error, 'POLICY_CHANGED');
  assert.equal(f.state.scans, 1);
});
