'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');
function analyze(source, more = {}) {
  return createFlowAnalysis(Object.entries({ 'index.js': source, ...more }).map(([path, content]) => ({ path, content }))).analyze('index.js');
}
const box = 'class Box { #value; constructor(value){this.#value=value} read(){return this.#value} }';
const sink = "fetch('/api',{body:box.read()});";

test('private fields cannot be overwritten by same-spelled public properties', () => {
  for (const write of ["box.value='public';", "box['#value']='public';", "box.value='public';box['#value']='public';"]) {
    const result = analyze(`${box}const box=new Box(process.env.TEST_TOKEN);${write}${sink}`);
    assert.equal(result.status, 'parsed');
    assert.ok(result.hints.some(h => h.kind === 'credential-export'), write);
  }
});

test('private field identity survives branch copies and joined class methods', () => {
  for (const write of ["if(flag)box.value='public';else box.value='other';", "if(flag)box['#value']='public';"]) {
    const result = analyze(`${box}const box=new Box(process.env.TEST_TOKEN);${write}${sink}`);
    assert.equal(result.status, 'parsed');
    assert.ok(result.hints.some(h => h.kind === 'credential-export'), write);
  }
});

test('imported private methods retain their defining lexical key identity', () => {
  const result = analyze("const Box=require('./lib/box');const box=new Box(process.env.TEST_TOKEN);box.value='public';" + sink,
    { 'lib/box.js': `module.exports=${box}` });
  assert.equal(result.status, 'parsed');
  assert.ok(result.hints.some(h => h.kind === 'credential-export'));
});

test('nested classes do not shadow their enclosing private environment', () => {
  const result = analyze("class Outer{#value;constructor(value){this.#value=value}read(){class Inner{#value='public';read(){return this.#value}} new Inner().read();return this.#value}} const box=new Outer(process.env.TEST_TOKEN);" + sink);
  assert.equal(result.status, 'parsed');
  assert.ok(result.hints.some(h => h.kind === 'credential-export'));
});

test('private and public fields remain separate in the benign direction', () => {
  const result = analyze(`${box}const box=new Box('public');box.value=process.env.TEST_TOKEN;module.exports=box.read();`);
  assert.equal(result.status, 'parsed');
  assert.equal(result.exports.value, 'public');
  assert.equal(result.exports.bits, 0);
});

test('getter uncertainty remains until descriptor and instance semantics are implemented', () => {
  const result = analyze('class Box{#value=1;get value(){return this.#value}} module.exports=new Box().value;');
  assert.equal(result.status, 'unmodeled');
});
