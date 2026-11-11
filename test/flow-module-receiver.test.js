'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');

function analyze(expression, { moduleSecret, receiverSecret, arrow = false }) {
  const read = "require('./prefix.js')+this.value";
  const files = {
    'lib/Box.js': arrow
      ? `module.exports=class Box{constructor(value){this.value=value;this.read=()=>${read}}}`
      : `module.exports=class Box{constructor(value){this.value=value}read(){return ${read}}}`,
    'lib/prefix.js': `module.exports=${moduleSecret ? 'process.env.TEST_TOKEN' : "'public'"};`,
    'prefix.js': "module.exports='caller-decoy';",
    'index.js': `const Box=require('./lib/Box');const clean=new Box('public');const target=new Box(${receiverSecret ? 'process.env.TEST_TOKEN' : "'public'"});fetch('/api',{body:${expression}});`
  };
  return createFlowAnalysis(Object.entries(files).map(([path, content]) => ({ path, content }))).analyze('index.js');
}

for (const expression of ['clean.read.call(target)', 'clean.read.apply(target,[])',
  'Reflect.apply(clean.read,target,[])', 'clean.read.bind(target)()',
  "[0].map(clean.read,target).join('')"]) {
  test(`module origin and explicit receiver both survive ${expression}`, () => {
    for (const [moduleSecret, receiverSecret] of [[false, false], [true, false], [false, true], [true, true]]) {
      const result = analyze(expression, { moduleSecret, receiverSecret });
      const note = JSON.stringify({ moduleSecret, receiverSecret, gaps: result.gaps });
      assert.equal(result.status, 'parsed', note);
      assert.equal(result.hints.some(h => h.kind === 'credential-export'), moduleSecret || receiverSecret, note);
    }
  });
}

test('an imported constructor arrow keeps module identity and lexical this through an array callback', () => {
  for (const [moduleSecret, receiverSecret] of [[false, false], [true, false], [false, true], [true, true]]) {
    const result = analyze("[0].map(target.read.bind(clean)).join('')", { moduleSecret, receiverSecret, arrow: true });
    const note = JSON.stringify({ moduleSecret, receiverSecret, gaps: result.gaps });
    assert.equal(result.status, 'parsed', note);
    assert.equal(result.hints.some(h => h.kind === 'credential-export'), moduleSecret || receiverSecret, note);
  }
});
