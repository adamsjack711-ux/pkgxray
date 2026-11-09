import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScanCoordinator } from '../src/scan-coordinator.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('identical in-flight scans share work and failed work can be retried', async () => {
  const queue = createScanCoordinator({ concurrency: 1, maxPending: 0 });
  const held = deferred();
  let calls = 0;
  const first = queue.run('same-artifact-context', () => { calls++; return held.promise; });
  const second = queue.run('same-artifact-context', () => { calls++; });
  assert.equal(first, second);
  const failure = assert.rejects(first, /scanner unavailable/);
  held.reject(new Error('scanner unavailable'));
  await failure;
  assert.equal(calls, 1);
  assert.equal(await queue.run('same-artifact-context', () => 'approved'), 'approved');
});

test('scan slots run in parallel, pending work is bounded, and queued jobs resume', async () => {
  const queue = createScanCoordinator({ concurrency: 2, maxPending: 1 });
  const a = deferred(), b = deferred();
  const started = [];
  const first = queue.run('a', () => { started.push('a'); return a.promise; });
  const second = queue.run('b', () => { started.push('b'); return b.promise; });
  const third = queue.run('c', () => { started.push('c'); return 'c'; });
  await assert.rejects(queue.run('d', () => assert.fail('overflow must not run')), /queue is full/);
  assert.deepEqual(started, ['a', 'b']);
  a.resolve('a');
  assert.equal(await third, 'c');
  b.resolve('b');
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(started, ['a', 'b', 'c']);
});

test('expired queued work never runs and releases its pending slot', async () => {
  const queue = createScanCoordinator({ concurrency: 1, maxPending: 1, queueTimeoutMs: 20 });
  const held = deferred();
  const first = queue.run('active', () => held.promise);
  try {
    await assert.rejects(queue.run('waiting', () => assert.fail('expired scan must not run')), /wait timed out/);
    const retry = queue.run('waiting', () => 'approved');
    held.resolve();
    assert.equal(await retry, 'approved');
    await first;
  } finally { held.resolve(); }
});
