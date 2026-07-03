import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runGuard, ScanError } from '../src/pkgxray-runner.js';

// A fake child process: emits stdout/stderr then closes with a code/signal.
function fakeSpawn({ stdout = '', stderr = '', code = 0, signal = null, delayMs = 0, emitError } = {}) {
  return function spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    const run = () => {
      if (emitError) {
        child.emit('error', emitError);
        return;
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, signal);
    };
    if (delayMs > 0) setTimeout(run, delayMs);
    else queueMicrotask(run);
    return child;
  };
}

test('parses allow verdict from JSON', async () => {
  const res = await runGuard('pkgxray', 'lodash@4.17.21', {
    spawnFn: fakeSpawn({ stdout: JSON.stringify({ decision: 'safe', findings: [] }) }),
  });
  assert.equal(res.decision, 'allow');
});

test('parses block verdict with findings', async () => {
  const res = await runGuard('pkgxray', 'evil@1.0.0', {
    spawnFn: fakeSpawn({
      stdout: JSON.stringify({ decision: 'block', findings: [{ id: 'X', reason: 'exfil' }] }),
      code: 2,
    }),
  });
  assert.equal(res.decision, 'block');
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].reason, 'exfil');
});

test('parses review verdict', async () => {
  const res = await runGuard('pkgxray', 'meh@1.0.0', {
    spawnFn: fakeSpawn({ stdout: JSON.stringify({ verdict: 'review', issues: [{ x: 1 }] }) }),
  });
  assert.equal(res.decision, 'review');
  assert.equal(res.findings.length, 1);
});

test('salvages JSON when a log line precedes it', async () => {
  const res = await runGuard('pkgxray', 'lodash@4.17.21', {
    spawnFn: fakeSpawn({ stdout: 'scanning...\n{"decision":"allow"}\n' }),
  });
  assert.equal(res.decision, 'allow');
});

test('falls back to exit code when JSON is unparseable', async () => {
  const res = await runGuard('pkgxray', 'x@1.0.0', {
    spawnFn: fakeSpawn({ stdout: 'not json at all', code: 2 }),
  });
  assert.equal(res.decision, 'block');
});

test('throws ScanError when neither JSON nor a known exit code', async () => {
  await assert.rejects(
    runGuard('pkgxray', 'x@1.0.0', { spawnFn: fakeSpawn({ stdout: 'garbage', code: 42 }) }),
    (err) => err instanceof ScanError,
  );
});

test('throws ScanError and kills child on timeout', async () => {
  await assert.rejects(
    runGuard('pkgxray', 'slow@1.0.0', {
      timeoutMs: 20,
      spawnFn: fakeSpawn({ stdout: '{"decision":"allow"}', delayMs: 200 }),
    }),
    (err) => err instanceof ScanError && err.timeout === true,
  );
});

test('throws ScanError on spawn "error" event', async () => {
  await assert.rejects(
    runGuard('pkgxray', 'x@1.0.0', {
      spawnFn: fakeSpawn({ emitError: new Error('ENOENT') }),
    }),
    (err) => err instanceof ScanError && /ENOENT/.test(err.message),
  );
});

test('forwards cacheUrl into child env', async () => {
  let capturedEnv;
  const spawnFn = (bin, args, opts) => {
    capturedEnv = opts.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('{"decision":"allow"}'));
      child.emit('close', 0, null);
    });
    return child;
  };
  await runGuard('pkgxray', 'lodash@4.17.21', {
    spawnFn, cacheUrl: 'http://cache.local:7000', env: { PATH: '/usr/bin' },
  });
  assert.equal(capturedEnv.PKGXRAY_CACHE_URL, 'http://cache.local:7000');
  assert.equal(capturedEnv.PATH, '/usr/bin');
});
