'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname,'../..');
const cli = path.join(root,'bin','compose.js');
function run(args, options = {}) {
  return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',cwd:root,timeout:10000,...options});
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'compose-xray-test-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true})); return dir;
}
for (const [name,status] of [['safe.yaml',0],['risky.yaml',2],['unresolved.yaml',3],['malformed.yaml',1]]) {
  test(`CLI ${name} returns ${status} and a single versioned JSON object`, () => {
    const p = run(['--file',`test/compose/fixtures/${name}`,'--format','json']);
    assert.equal(p.status,status); assert.equal(p.stderr,'');
    const r = JSON.parse(p.stdout); assert.equal(r.exitCode,status); assert.equal(r.schemaVersion,1);
  });
}
test('CLI text contains source location, evidence, explanation and remediation', () => {
  const p = run(['-f','test/compose/fixtures/risky.yaml']);
  assert.equal(p.status,2); assert.match(p.stdout,/risky.yaml:\d+/);
  assert.match(p.stdout,/Evidence:/); assert.match(p.stdout,/Change:/);
  assert.match(p.stdout,/Connected evidence:/);
});
test('help and version are local commands', () => {
  assert.match(run(['--help']).stdout,/Exit codes: 0/);
  assert.equal(run(['--version']).stdout,'0.1.0\n');
});
for (const args of [[], ['--file'], ['--oops','password=do-not-print'],
  ['-f','absent-do-not-print.yaml'], ['--format','json','--file','missing-do-not-print'],
  ['--file','test/compose/fixtures/safe.yaml','--format','xml']]) test(`CLI input failure ${JSON.stringify(args)}`, () => {
  const p = run([...args,'--format','json']); assert.equal(p.status,1);
  assert.equal(p.stderr,''); assert.ok(!p.stdout.includes('do-not-print'));
  assert.equal(JSON.parse(p.stdout).status,'error');
});
test('CLI policy is explicit, visible and never auto-discovered', t => {
  const dir = temp(t); const compose = path.join(dir,'compose.yaml');
  const policy = path.join(dir,'.compose-xray.json');
  fs.writeFileSync(compose,'services: {app: {privileged: true}}');
  fs.writeFileSync(policy,JSON.stringify({schemaVersion:1,suppressions:[{ruleId:'CXR-002',service:'app',reason:'Isolated lab'}]}));
  assert.equal(run(['-f',compose]).status,2);
  const p = run(['-f',compose,'--policy',policy,'--format','json']);
  assert.equal(p.status,0); assert.equal(JSON.parse(p.stdout).summary.suppressed,1);
  fs.writeFileSync(policy,'{"secret":"broken-do-not-print",');
  const bad = run(['-f',compose,'--policy',policy,'--format','json']);
  assert.equal(bad.status,1); assert.ok(!bad.stdout.includes('broken-do-not-print'));
});
test('multiple -f inputs do not silently use just the first file', () => {
  const p = run(['-f','test/compose/fixtures/safe.yaml','-f','test/compose/fixtures/risky.yaml','--format','json']);
  assert.equal(p.status,3); assert.match(p.stdout,/No supplied file was audited/);
});
test('sibling override produces an incomplete result without reading it', t => {
  const dir = temp(t); const compose = path.join(dir,'compose.yaml');
  fs.writeFileSync(compose,'services: {app: {}}');
  fs.writeFileSync(path.join(dir,'compose.override.yaml'),'malformed-secret-do-not-print: [');
  const p = run(['-f',compose,'--format','json']);
  assert.equal(p.status,3); assert.match(p.stdout,/sibling override/);
  assert.ok(!p.stdout.includes('malformed-secret-do-not-print'));
});
test('CLI ignores ambient variables and .env; interpolation remains incomplete', t => {
  const dir = temp(t); const compose = path.join(dir,'compose.yaml');
  fs.writeFileSync(compose,'services: {app: {ports: ["${PORT}:80"]}}');
  fs.writeFileSync(path.join(dir,'.env'),'PORT=8080\nPASSWORD=env-do-not-print');
  const a = run(['-f',compose,'--format','json'],{env:{...process.env,PORT:'8080'}});
  const b = run(['-f',compose,'--format','json'],{env:{...process.env,PORT:'9090'}});
  assert.equal(a.status,3); assert.equal(a.stdout,b.stdout);
});
test('malformed YAML, complex keys and unexpected tags cannot leak on stderr or stdout', t => {
  const dir = temp(t); const file = path.join(dir,'bad.yaml');
  for (const source of [
    'services: {app: {x-test: {? [key-secret-do-not-print, other]: value}}}',
    'services: {app: {}}\nx-test: !!set {tag-secret-do-not-print: null}',
    'services: {app: !secret-do-not-print {}}',
    'services: {app: {x-secret: first, x-secret: duplicate-secret-do-not-print}}',
    'services: {app: {environment: [PASSWORD=parser-secret-do-not-print}'
  ]) {
    fs.writeFileSync(file,source);
    const p = run(['-f',file,'--format','json']);
    assert.equal(p.status,1); assert.equal(p.stderr,'');
    assert.ok(!p.stdout.includes('secret-do-not-print'));
  }
});
test('invalid UTF-8, directory input, and oversized files fail without dumping input', t => {
  const dir = temp(t); const file = path.join(dir,'bad.yaml');
  for (const buffer of [Buffer.from([0xc3,0x28]),Buffer.alloc(1024*1024+1,65)]) {
    fs.writeFileSync(file,buffer); assert.equal(run(['-f',file]).status,1);
  }
  assert.equal(run(['-f',dir]).status,1);
});
test('scanning does not execute project code, make network calls, read extra files, or mutate inputs', t => {
  const dir = temp(t); const marker = path.join(dir,'executed');
  const compose = path.join(dir,'compose.yaml');
  const source = `services:\n  app:\n    image: invalid.example/would-pull:latest\n    build: ./project\n    command: '$(touch ${marker})'\n    env_file: ./never-read.env\n    ports: ["8080:80"]\n    privileged: true\ninclude: [https://invalid.example/never-fetch.yaml]\n`;
  fs.writeFileSync(compose,source);
  const guard = path.join(dir,'guard.cjs');
  // Test-only preload: fail if the CLI even attempts these side effects.
  fs.writeFileSync(guard,`const cp = require('node:child_process');
const deny = () => { process.stderr.write('FORBIDDEN_SIDE_EFFECT'); throw new Error('forbidden'); };
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[key] = deny;
require('node:http').request = deny; require('node:http').get = deny;
require('node:https').request = deny; require('node:https').get = deny;
require('node:net').connect = deny; require('node:net').createConnection = deny;
require('node:net').Socket.prototype.connect = deny;
require('node:dgram').createSocket = deny; global.fetch = deny;
const fs = require('node:fs');
const read = fs.readFileSync; const open = fs.openSync;
const allowed = p => typeof p === 'number' || /(?:\\.js|\\.cjs|\\.json)$/.test(String(p)) || String(p) === ${JSON.stringify(compose)};
fs.readFileSync = function(p,...args) { if(!allowed(p)) deny(); return read.call(this,p,...args); };
fs.openSync = function(p,...args) { if(!allowed(p)) deny(); return open.call(this,p,...args); };
for(const key of ['writeFileSync','appendFileSync','unlinkSync','renameSync','mkdirSync']) fs[key] = deny;
`);
  const p = spawnSync(process.execPath,['--require',guard,cli,'-f',compose,'--format','json'],{encoding:'utf8',timeout:10000});
  assert.equal(p.status,3); assert.equal(p.stderr,'');
  assert.equal(fs.existsSync(marker),false); assert.equal(fs.readFileSync(compose,'utf8'),source);
  assert.equal(JSON.parse(p.stdout).summary.active,3);
});
