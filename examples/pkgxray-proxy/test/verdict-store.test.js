import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VerdictStore } from '../src/verdict-store.js';

function tmpStore(name = 'verdicts.json') {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-'));
  return { dir, path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('roundtrip: set then get', () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = new VerdictStore(path);
    store.set('lodash', '4.17.21', 'allow', []);
    assert.deepEqual(store.get('lodash', '4.17.21').decision, 'allow');
    assert.equal(store.has('lodash', '4.17.21'), true);
  } finally {
    cleanup();
  }
});

test('persists across restart', () => {
  const { path, cleanup } = tmpStore();
  try {
    const a = new VerdictStore(path);
    a.set('evil', '1.0.0', 'block', [{ reason: 'malware' }]);
    const b = new VerdictStore(path);
    const entry = b.get('evil', '1.0.0');
    assert.equal(entry.decision, 'block');
    assert.equal(entry.findings[0].reason, 'malware');
  } finally {
    cleanup();
  }
});

test('does not cache scan errors or unknown decisions', () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = new VerdictStore(path);
    assert.equal(store.set('x', '1.0.0', 'error', []), false);
    assert.equal(store.set('x', '1.0.0', 'unknown', []), false);
    assert.equal(store.has('x', '1.0.0'), false);
  } finally {
    cleanup();
  }
});

test('caches review verdicts', () => {
  const { path, cleanup } = tmpStore();
  try {
    const store = new VerdictStore(path);
    assert.equal(store.set('y', '2.0.0', 'review', []), true);
    assert.equal(store.get('y', '2.0.0').decision, 'review');
  } finally {
    cleanup();
  }
});

test('tolerates a corrupt store file', () => {
  const { path, cleanup } = tmpStore();
  try {
    writeFileSync(path, '{ this is not json ');
    const store = new VerdictStore(path); // must not throw
    assert.equal(store.size(), 0);
    store.set('ok', '1.0.0', 'allow');
    assert.equal(store.has('ok', '1.0.0'), true);
  } finally {
    cleanup();
  }
});

test('drops non-cacheable entries when loading', () => {
  const { path, cleanup } = tmpStore();
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      verdicts: {
        'good@1.0.0': { decision: 'allow', findings: [], ts: 1 },
        'bad@1.0.0': { decision: 'error', findings: [], ts: 2 },
      },
    }));
    const store = new VerdictStore(path);
    assert.equal(store.has('good', '1.0.0'), true);
    assert.equal(store.has('bad', '1.0.0'), false);
  } finally {
    cleanup();
  }
});

test('stamps ts via injected clock and writes atomically', () => {
  const { path, cleanup } = tmpStore();
  try {
    let t = 1000;
    const store = new VerdictStore(path, { now: () => t });
    store.set('a', '1.0.0', 'allow');
    assert.equal(store.get('a', '1.0.0').ts, 1000);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(onDisk.verdicts['a@1.0.0'].ts, 1000);
  } finally {
    cleanup();
  }
});
