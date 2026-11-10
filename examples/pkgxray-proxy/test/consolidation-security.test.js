import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireArtifact, gateArtifact } from '../src/artifact-gate.js';
import { VerdictStore } from '../src/verdict-store.js';
import { loadConfig } from '../src/config.js';
import { withReceipt } from './receipt-helper.js';

test('disconnecting the scan owner keeps its real snapshot alive for another caller', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pkgxray-snapshot-lease-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = http.createServer((_req, res) => res.end('inert shared archive'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const url = `http://127.0.0.1:${upstream.address().port}/archive`;
  const a = await acquireArtifact(http.request, url);
  const b = await acquireArtifact(http.request, url);
  t.after(() => Promise.all([a.cleanup(), b.cleanup()]));
  const config = loadConfig({ verdictStorePath: join(dir, 'store.json') }, {});
  const store = new VerdictStore(config.verdictStorePath);
  let release, began, scans = 0;
  const started = new Promise(resolve => { began = resolve; });
  const runGuard = withReceipt(async (_bin, _ref, opts) => {
    scans++; began(); await new Promise(resolve => { release = resolve; });
    assert.equal(await readFile(opts.artifact.archivePath, 'utf8'), 'inert shared archive');
    return { decision: 'allow', findings: [] };
  });
  const check = (snapshot, signal) => gateArtifact({ config, store, name: 'demo', version: '1.0.0', snapshot, signal, runGuard });
  const controller = new AbortController();
  const first = check(a, controller.signal), second = check(b);
  await started; controller.abort();
  assert.equal((await first).serve, false);
  await a.cleanup(); assert.ok(await stat(a.file));
  release(); assert.equal((await second).serve, true); assert.equal(scans, 1);
  // Resource cleanup runs after the shared evidence promise resolves.
  for (let i = 0; i < 100; i++) {
    try { await stat(a.file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('shared snapshot was not released after the scan completed');
});
