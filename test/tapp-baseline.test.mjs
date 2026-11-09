import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../src/analyze.mjs';
import { tappBaseline, baselineExitCode } from '../research/tapp-baseline.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ray-tapp-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = { name: 'tapp-backend', version: '0.1.0', type: 'module' };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': manifest } }));
  fs.mkdirSync(path.join(root, 'src'));
  for (const file of ['server.mjs', 'apple-auth.mjs', 'voice.mjs']) {
    fs.writeFileSync(path.join(root, 'src', file), 'export const fixture=async()=>true;');
  }
  return root;
}

test('Tapp baseline fingerprints all selected entries without clearing unsupported flows', t => {
  const root = fixture(t);
  const r = tappBaseline({ root });
  assert.equal(r.cases.length, 3);
  assert.ok(r.cases.every(c => c.sourceCollected && c.flow === 'incomplete' && c.gapCodes.includes('unsupported-semantics')));
  assert.ok(r.cases.every(c => c.flowFindings === 0 && c.packageChecks === 'not-requested'));
  assert.equal(baselineExitCode(r), 2);
});

test('ESM collection respects byte bounds, missing files, and symlinks', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'src/server.mjs'), 'x'.repeat(2048));
  const large = analyzeProject({ root, entry: 'src/server.mjs', limits: { maxFileBytes: 1024 } });
  assert.ok(large.gaps.some(g => g.code === 'file-budget'));
  assert.ok(!large.packages.some(p => p.files.some(f => f.file === 'src/server.mjs')));
  fs.unlinkSync(path.join(root, 'src/server.mjs'));
  assert.ok(analyzeProject({ root, entry: 'src/server.mjs' }).gaps.some(g => g.code === 'missing-source'));
  fs.symlinkSync(path.join(root, 'src/voice.mjs'), path.join(root, 'src/server.mjs'));
  assert.ok(analyzeProject({ root, entry: 'src/server.mjs' }).gaps.some(g => g.code === 'unsupported-symlink'));
});

test('module-typed .js is retained as evidence but never executed', t => {
  const root = fixture(t);
  const marker = path.join(root, 'must-not-exist');
  fs.writeFileSync(path.join(root, 'src/auth.js'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');`);
  const r = analyzeProject({ root, entry: 'src/auth.js' });
  assert.equal(r.verdict, 'incomplete');
  assert.ok(r.packages.some(p => p.files.some(f => f.file === 'src/auth.js')));
  assert.equal(fs.existsSync(marker), false);
});

test('baseline CLI emits JSON with an incomplete exit and rejects missing arguments', t => {
  const root = fixture(t);
  const cli = fileURLToPath(new URL('../research/tapp-baseline.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, root, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).cases.length, 3);
  assert.equal(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 2);
});
