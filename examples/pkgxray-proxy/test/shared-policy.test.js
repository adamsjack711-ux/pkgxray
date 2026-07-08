import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gate, loadSharedPolicy } from '../src/proxy.js';
import { loadConfig } from '../src/config.js';
import { VerdictStore } from '../src/verdict-store.js';

// A digest the "scan" will report and the shared allowlist will pin to.
const PINNED_SHA = 'a'.repeat(64);

function fixture(shared) {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-proxy-shared-'));
  const config = loadConfig({ verdictStorePath: join(dir, 'v.json') }, {});
  const store = new VerdictStore(config.verdictStorePath);
  return { dir, config, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Write a real .pkgxray.json into a temp dir and load it through the shared
// loader, exactly as the proxy does at startup.
function sharedPolicyWith(allow) {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-shared-cfg-'));
  writeFileSync(join(dir, '.pkgxray.json'), JSON.stringify({ allow }), 'utf8');
  const policy = loadSharedPolicy({ cwd: dir });
  return { policy, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a pinned allow in a shared .pkgxray.json clears a package the proxy would block, and logs the effect', async () => {
  const { config, store, cleanup } = fixture();
  const { policy, cleanup: cleanupCfg } = sharedPolicyWith([
    { pkg: 'sketchy@1.0.0', sha256: PINNED_SHA, reason: 'reviewed by security 2026-07' },
  ]);
  try {
    // Sanity: the shared file was actually adopted (not the null zero-config case).
    assert.ok(policy, 'shared policy should load from the temp .pkgxray.json');
    assert.equal(policy.allow.length, 1, 'the pinned allow survived validation');

    const logs = [];
    // The raw scan says BLOCK — without the shared policy this package is gated.
    const runGuard = async () => ({
      decision: 'block',
      findings: [{ category: 'install-hook', severity: 'high', reason: 'runs a postinstall script' }],
      sha256: PINNED_SHA,
    });

    const d = await gate({
      config, store, name: 'sketchy', version: '1.0.0',
      runGuard, sharedPolicy: policy,
      log: (e) => logs.push(e),
    });

    // The pinned allow (sha256 matches) forces the verdict to allow -> served.
    assert.equal(d.serve, true, 'pinned allow should clear the block');
    assert.equal(d.status, 200);
    assert.equal(d.decision, 'allow');

    // The effect is surfaced on the decision, never silent.
    assert.ok(Array.isArray(d.configEffects) && d.configEffects.length > 0, 'configEffects present');
    assert.ok(
      d.configEffects.some((line) => /allowlisted/i.test(line) && /sketchy@1\.0\.0/.test(line)),
      `expected an allowlisted effect line, got: ${JSON.stringify(d.configEffects)}`,
    );

    // And the stored verdict reflects the cleared (allow) decision.
    assert.equal(store.get('sketchy', '1.0.0').decision, 'allow');
  } finally {
    cleanupCfg();
    cleanup();
  }
});

test('the pinned allow does NOT apply when the scanned sha256 differs (bytes not vouched for)', async () => {
  const { config, store, cleanup } = fixture();
  const { policy, cleanup: cleanupCfg } = sharedPolicyWith([
    { pkg: 'sketchy@1.0.0', sha256: PINNED_SHA, reason: 'reviewed' },
  ]);
  try {
    const runGuard = async () => ({
      decision: 'block',
      findings: [{ category: 'install-hook', severity: 'high', reason: 'x' }],
      sha256: 'b'.repeat(64), // different bytes than the pin
    });
    const d = await gate({
      config, store, name: 'sketchy', version: '1.0.0',
      runGuard, sharedPolicy: policy, log: () => {},
    });
    assert.equal(d.serve, false, 'a digest mismatch must not honor the pin');
    assert.equal(d.status, 403);
    assert.equal(d.decision, 'block');
  } finally {
    cleanupCfg();
    cleanup();
  }
});

test('loadSharedPolicy returns null when no .pkgxray.json exists (proxy keeps its own settings)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pkgxray-shared-empty-'));
  try {
    assert.equal(loadSharedPolicy({ cwd: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
