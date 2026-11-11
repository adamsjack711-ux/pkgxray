'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SharedScans, analyzeShared } = require('../src/shared-scans');
const { reviewIdentity, reviewOutcome } = require('../src/review');
const { start, evidence, call } = require('./helpers/mcp-load-client');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('shared jobs retain resources through owner cancellation and release every rejected or queued lease', async t => {
  const service = new SharedScans({ concurrency: 1, maxQueue: 1 }); t.after(() => service.close());
  let retained = 0, released = 0, finish;
  const retain = () => { retained++; return () => { released++; }; };
  const controller = new AbortController();
  const a = service.get('shared', () => new Promise(resolve => { finish = resolve; }), { signal: controller.signal, retain });
  const b = service.get('shared', () => assert.fail('must share the first scan'), { retain });
  await tick(); controller.abort();
  await assert.rejects(a, { code: 'SCAN_CANCELLED' });
  assert.equal(retained, 1); assert.equal(released, 0);
  const queuedController = new AbortController();
  const queued = service.get('queued', () => assert.fail('cancelled queued work must not run'), { signal: queuedController.signal, retain });
  await assert.rejects(service.get('overflow', () => ({}), { retain }), { code: 'SCAN_OVERLOADED' });
  queuedController.abort(); await assert.rejects(queued, { code: 'SCAN_CANCELLED' });
  await tick(); assert.equal(released, 2);
  finish({ ok: true }); assert.equal((await b).evidence.ok, true);
  await tick(); assert.equal(released, retained);

  const immediate = new AbortController();
  const cancelled = service.get('before-start', () => assert.fail('cancelled work must not start'), { signal: immediate.signal, retain });
  immediate.abort(); await assert.rejects(cancelled, { code: 'SCAN_CANCELLED' });
  await tick(); assert.equal(released, retained); assert.equal(service.snapshot().jobs, 0);
});

test('100 actual MCP stdio cold requests share exactly one scan; warm requests share evidence', async t => {
  const client = start(); t.after(() => client.close()); await client.init();
  const batch = await Promise.all(Array.from({ length: 100 }, () => call(client, evidence())));
  assert.ok(batch.every(r => r.result?.structuredContent));
  const stats = await client.stats(); assert.equal(stats.scans.scans, 1);
  assert.equal(stats.scans.joined, 99);
  await call(client, evidence()); assert.equal((await client.stats()).scans.hits, 1);
  const changed = await call(client, evidence(1)); assert.ok(changed.result);
  assert.equal((await client.stats()).scans.scans, 2);
});

test('MCP cancellation is request-specific, overload is explicit, and the session recovers', async t => {
  const client = start(); t.after(() => client.close()); await client.init();
  const a = call(client, evidence()), b = call(client, evidence());
  client.notify('notifications/cancelled', { requestId: a.id });
  assert.equal((await a).error.code, -32800); assert.ok((await b).result);
  const batch = await Promise.all(Array.from({ length: 100 }, (_, i) => call(client, evidence(i + 100))));
  assert.ok(batch.some(r => r.error?.code === -32001));
  assert.ok(batch.every(r => r.result || r.error?.code === -32001));
  assert.equal((await client.stats()).scans.peakActive <= 4, true);
  assert.ok((await call(client, evidence(1000))).result);
});

test('coordinator cancels only unneeded work, bounds queue, times out and recovers without caching errors', async t => {
  const service = new SharedScans({ concurrency: 1, maxQueue: 1, timeoutMs: 60 }); t.after(() => service.close());
  let release, aborted = 0;
  const scan = signal => new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => { aborted++; resolve({}); }); });
  const controller = new AbortController();
  const a = service.get('a', scan, { signal: controller.signal });
  const b = service.get('a', scan); await tick();
  controller.abort(); await assert.rejects(a, { code: 'SCAN_CANCELLED' }); assert.equal(aborted, 0);
  const queuedController = new AbortController();
  const q = service.get('q', scan, { signal: queuedController.signal });
  await assert.rejects(service.get('overflow', scan), { code: 'SCAN_OVERLOADED' });
  queuedController.abort(); await assert.rejects(q, { code: 'SCAN_CANCELLED' });
  release({ findings: [{ reason: 'immutable' }] }); const result = await b;
  assert.throws(() => { result.evidence.findings[0].reason = 'changed'; }, TypeError);
  await tick();
  await assert.rejects(service.get('error', async () => { throw new Error('fixture failure'); }), /fixture failure/); await tick();
  assert.equal((await service.get('error', async () => ({ recovered: true }))).evidence.recovered, true); await tick();
  await assert.rejects(service.get('timeout', scan), { code: 'SCAN_TIMEOUT' }); await tick();
  assert.equal(service.snapshot().jobs, 0); assert.equal(service.snapshot().waiters, 0);
  assert.equal((await service.get('after', async () => ({ ok: true }))).evidence.ok, true);
});

test('analysis inputs, ruleset and TTL invalidate immutable evidence independently of policy choices', async t => {
  const service = new SharedScans({ ttlMs: 1 }); t.after(() => service.close());
  const input = evidence(); delete input.outputFormat;
  await analyzeShared(input, {}, { service, buildId: 'rules1' });
  await analyzeShared(input, {}, { service, buildId: 'rules2' });
  await analyzeShared(input, { typosquat: true }, { service, buildId: 'rules2' });
  assert.equal(service.metrics.scans, 3);
  await new Promise(resolve => setTimeout(resolve, 5));
  await analyzeShared(input, { typosquat: true }, { service, buildId: 'rules2' });
  assert.equal(service.metrics.scans, 4);
});

test('evidence identities remain bound but old review choices never authorize', () => {
  const receipt = { artifactSha256: 'a', policySha256: 'p', scannerBuildId: 's', analysisSha256: 'config', evidenceSha256: 'findings' };
  const id = reviewIdentity(receipt, { action: 'promote', target: '/a' });
  for (const field of ['artifactSha256','policySha256','scannerBuildId','analysisSha256','evidenceSha256']) {
    assert.notEqual(reviewIdentity({ ...receipt, [field]: 'changed' }, { action: 'promote', target: '/a' }), id);
  }
  assert.deepEqual(reviewOutcome('review', { scope: 'A', decisions: { present: () => 'Proceed' } }),
    { allowed: false, outcome: 'UNSAFE', review: null });
});

test('real worker timeout and last-caller cancellation release all capacity', async t => {
  const service = new SharedScans({ concurrency: 1, maxQueue: 1, timeoutMs: 1 }); t.after(() => service.close());
  const input = evidence(); delete input.outputFormat;
  await assert.rejects(analyzeShared(input, {}, { service }), { code: 'SCAN_TIMEOUT' });
  for (let i=0; i<100 && service.snapshot().active; i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(service.snapshot().active, 0); assert.equal(service.snapshot().jobs, 0); assert.equal(service.snapshot().waiters, 0);
  service.timeoutMs = 30000;
  const controller = new AbortController();
  const pending = analyzeShared(input, {}, { service, signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(pending, { code: 'SCAN_CANCELLED' });
  for (let i=0; i<100 && service.snapshot().active; i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(service.snapshot().active, 0);
  assert.ok((await analyzeShared(input, {}, { service })).evidence);
});

test('changed caller policy is applied per MCP request without approving cached evidence', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'pkgxray-mcp-policy-'));
  let client;
  t.after(async () => {
    try { await client?.close(); }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  client = start('static', { cwd: dir }); await client.init();
  const initial = await call(client, evidence()); assert.ok(initial.result);
  await fs.writeFile(path.join(dir,'.pkgxray.json'), JSON.stringify({ mcp: { tools: ['guard'] } }));
  const denied = await call(client, evidence()); assert.ok(denied.error);
  assert.equal((await client.stats()).scans.scans, 1, 'disabled tool must not consume cached authorization');
  await fs.writeFile(path.join(dir,'.pkgxray.json'), '{}');
  assert.ok((await call(client,evidence())).result);
});

test('100 guard requests through MCP share static analysis but never share staging or promotion', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'pkgxray-mcp-guard-load-'));
  let client;
  t.after(async () => {
    try { await client?.close(); }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  const source = path.join(dir,'package'); await fs.mkdir(source);
  await fs.writeFile(path.join(source,'package.json'), JSON.stringify({ name: 'inert-guard', version: '1.0.0', scripts: { postinstall: 'node setup.js' } }));
  await fs.writeFile(path.join(source,'setup.js'), 'exports.value = 1;');
  client = start('static', { cwd: dir }); await client.init();
  const requests = Array.from({length:100}, () => client.request('tools/call', { name: 'guard_agent_extension_install', arguments: {
    reference: source, sourceScan: true, vulnerabilityCheck: false, githubMetadata: false, githubDiff: false, outputFormat: 'json'
  } }));
  const responses = await Promise.all(requests);
  for (const response of responses) {
    assert.ok(response.result, JSON.stringify(response));
    const scan = response.result.structuredContent;
    assert.equal(scan.allowed, false); assert.equal(scan.decision, 'block');
    assert.equal(Object.hasOwn(scan, 'review'), false);
    assert.equal(Object.hasOwn(scan, 'reviewPlan'), false);
    assert.ok(scan.resolution.reasonCodes.includes('vulnerability-check-disabled'));
    for (const key of ['promotedPath', 'stagedPath', 'quarantinePath', 'sourceFiles']) assert.equal(Object.hasOwn(scan, key), false);
  }
  const stats = await client.stats();
  assert.equal(stats.scans.scans,1);
  assert.ok(stats.preparation.peakActive <= 4);
  assert.equal(stats.preparation.waiters,0);
});
