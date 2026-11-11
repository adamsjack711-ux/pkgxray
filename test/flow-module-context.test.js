'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');

function analyze(files, entry = 'index.js') {
  return createFlowAnalysis(Object.entries(files).map(([path, content]) => ({ path, content }))).analyze(entry);
}
const secret = 'module.exports=process.env.TEST_TOKEN;';
const publicValue = "module.exports='public';";
const sink = value => `fetch('/api',{body:${value}});`;
function exportedSecret(result, note) {
  assert.equal(result.status, 'parsed', `${note}: ${JSON.stringify(result.gaps)}`);
  assert.ok(result.hints.some(h => h.kind === 'credential-export'), note);
}

test('imported constructors and methods resolve local sources in their defining module', () => {
  for (const helper of [
    "module.exports=class Box{constructor(){this.value=require('./value.js')}read(){return this.value}}",
    "module.exports=class Box{read(){return require('./value.js')}}"
  ]) {
    exportedSecret(analyze({
      'lib/Box.js': helper, 'lib/value.js': secret, 'value.js': publicValue,
      'index.js': `const Box=require('./lib/Box');const box=new Box();${sink('box.read()')}`
    }), helper);
  }
});

test('CommonJS and ES functions retain lexical resolution after import, aliasing and branch joins', () => {
  for (const [helper, imports] of [
    ["module.exports=function(){return require('./value.js')}", "let read=require('./lib/read');"],
    ["exports.read=function(){return require('./value.js')}", "let read=require('./lib/read').read;"],
    ["export default function read(){return require('./value.js')}", "import read from './lib/read.js';"],
    ["export function read(){return require('./value.js')}", "import {read} from './lib/read.js';"]
  ]) {
    for (const joined of [false, true]) {
      exportedSecret(analyze({
        'lib/read.js': helper, 'lib/value.js': secret, 'value.js': publicValue,
        'index.js': `${imports} let invoke=read;${joined ? 'if(flag)invoke=read;' : ''}${sink('invoke()')}`
      }), `${helper}, join=${joined}`);
    }
  }
});

test('nested functions and closures created during imported invocation keep their defining file', () => {
  for (const helper of [
    "module.exports=function(){return ()=>require('./value.js')}",
    "module.exports=function(){function read(){return require('./value.js')}return read}",
    "module.exports=function(){return function(){return require('./value.js')}}"
  ]) {
    exportedSecret(analyze({
      'lib/factory.js': helper, 'lib/value.js': secret, 'value.js': publicValue,
      'index.js': `const factory=require('./lib/factory');let read=factory();if(flag)read=read;${sink('read()')}`
    }), helper);
  }
});

test('relative dynamic imports inside foreign functions retain module identity', () => {
  exportedSecret(analyze({
    'lib/read.js': "export default async function(){return (await import('./value.js')).default}",
    'lib/value.js': 'export default process.env.TEST_TOKEN;',
    'value.js': "export default 'public';",
    'index.js': `import read from './lib/read.js';${sink('await read()')}`
  }), 'relative dynamic import');
});

test('callable alternatives preserve the distinct module identity of every branch', () => {
  exportedSecret(analyze({
    'private/read.js': "module.exports=()=>require('./value.js')",
    'private/value.js': secret,
    'public/read.js': "module.exports=()=>require('./value.js')",
    'public/value.js': publicValue,
    'value.js': publicValue,
    'index.js': `let read=require('./public/read');if(flag)read=require('./private/read');${sink('read()')}`
  }), 'joined foreign callable alternatives');
});

test('caller callbacks keep their own resolution context inside an imported wrapper', () => {
  exportedSecret(analyze({
    'lib/run.js': 'module.exports=function(callback){return callback()}',
    'lib/value.js': publicValue, 'value.js': secret,
    'index.js': `const run=require('./lib/run');${sink("run(()=>require('./value.js'))")}`
  }), 'caller callback');
});

test('returning from imported calls restores caller context and does not invent secret flow', () => {
  const result = analyze({
    'lib/read.js': "module.exports=()=>require('./value.js')",
    'lib/value.js': secret, 'value.js': publicValue,
    'index.js': `require('./lib/read')();${sink("require('./value.js')")}`
  });
  assert.equal(result.status, 'parsed');
  assert.deepEqual(result.hints, []);
});

test('a missing defining-module dependency never falls back to a caller module', () => {
  const result = analyze({
    'lib/read.js': "module.exports=()=>require('./value.js')",
    'value.js': publicValue,
    'index.js': `const read=require('./lib/read');${sink('read()')}`
  });
  assert.notEqual(result.status, 'parsed');
});

test('passing a require capability across modules preserves the loader origin, not the invoked function origin', () => {
  exportedSecret(analyze({
    'lib/read.js': "module.exports=function(loader){return loader('./value.js')}",
    'lib/value.js': publicValue, 'value.js': secret,
    'index.js': `const read=require('./lib/read');${sink('read(require)')}`
  }), 'caller loader passed to foreign function');
});

test('returned and joined require capabilities retain their defining module', () => {
  for (const loader of ['require', 'module.require']) {
    exportedSecret(analyze({
      'lib/loader.js': `module.exports=function(){return ${loader}}`,
      'lib/value.js': secret, 'value.js': publicValue,
      'index.js': `const factory=require('./lib/loader');let load=factory();if(flag)load=factory();${sink("load('./value.js')")}`
    }), loader);
  }
});

test('uncertain createRequire base does not pretend to load from the current module', () => {
  const result = analyze({
    'value.js': publicValue,
    'index.js': `const {createRequire}=require('module');const read=createRequire(unknownBase);${sink("read('./value.js')")}`
  });
  assert.notEqual(result.status, 'parsed');
});

test('the public analyzer no longer clears the same-name caller-module substitution', () => {
  const { auditEvidence } = require('../src/auditor');
  const report = auditEvidence({ sourceFiles: {
    'package.json': '{"name":"module-context-fixture","main":"index.js"}',
    'lib/Box.js': "module.exports=class Box{constructor(){this.value=require('./value.js')}read(){return this.value}}",
    'lib/value.js': secret, 'value.js': publicValue,
    'index.js': `const Box=require('./lib/Box');${sink('new Box().read()')}`
  } });
  assert.notEqual(report.verdict, 'safe');
  assert.ok(report.findings.some(f => f.category === 'credential-export'));
});


test('default parameter loads execute against the defining module before the function body', () => {
  exportedSecret(analyze({
    'lib/read.js': "module.exports=function(value=require('./value.js')){return value}",
    'lib/value.js': secret, 'value.js': publicValue,
    'index.js': `const read=require('./lib/read');${sink('read()')}`
  }), 'default parameter');
});

test('foreign ambient export writes cannot overwrite the invoking module exports', () => {
  for (const mutation of ["module.exports='public';", "exports.value='public';", "module.exports.value='public';"]) {
    const result = analyze({
      'lib/helper.js': `module.exports=function(){${mutation}}`,
      'root.js': "module.exports={value:process.env.TEST_TOKEN}; require('./lib/helper')();",
      'index.js': sink("require('./root').value")
    });
    assert.notEqual(result.status, 'parsed', mutation);
    assert.ok(result.hints.some(h => h.kind === 'credential-export'), mutation);
  }
});


test('foreign ambient exports reads retain uncertainty rather than inventing a clean value', () => {
  for (const expression of ['module.exports.value', "module['exports'].value", 'exports.value',
    '(()=>{const owner=module;return owner.exports.value})()',
    "Reflect.get(module,'exports').value", '(()=>{const {exports:own}=module;return own.value})()']) {
    const result = analyze({
      'lib/helper.js': `exports.value=process.env.TEST_TOKEN;exports.read=function(){return ${expression}};`,
      'index.js': sink("require('./lib/helper').read()")
    });
    assert.notEqual(result.status, 'parsed', expression);
    assert.ok(result.gaps.some(g => /foreign module export read/.test(g.reason)), expression);
  }
});

test('stdio MCP follows the defining module for secret and public constructor controls', async () => {
  const { start, call } = require('./helpers/mcp-load-client');
  const client = start();
  try {
    await client.init();
    for (const [value, expected] of [[secret, 'block'], [publicValue, 'safe']]) {
      const reply = await call(client, { outputFormat: 'json', sourceFiles: {
        'package.json': '{"name":"module-context-fixture","main":"index.js"}',
        'lib/Box.js': "module.exports=class Box{constructor(){this.value=require('./value.js')}read(){return this.value}}",
        'lib/value.js': value, 'value.js': publicValue,
        'index.js': `const Box=require('./lib/Box');${sink('new Box().read()')}`
      } });
      assert.equal(reply.result.structuredContent.verdict, expected);
      if (expected === 'block') assert.ok(reply.result.structuredContent.findings.some(f => f.category === 'credential-export'));
    }
  } finally { await client.close(); }
});


test('captured ambient export aliases keep opaque module ownership through joins', () => {
  for (const value of ['exports', 'module.exports']) for (const read of ['selected.value', 'Object.values(selected)[0]']) {
    const result = analyze({
      'lib/helper.js': `const own=${value};exports.value=process.env.TEST_TOKEN;exports.read=function(){let selected=own;if(flag)selected=own;return ${read}};`,
      'index.js': sink("require('./lib/helper').read()")
    });
    assert.notEqual(result.status, 'parsed', value);
    assert.ok(result.gaps.some(g => /foreign module export read/.test(g.reason)), value);
  }
});
