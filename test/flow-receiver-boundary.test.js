'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');
const { auditEvidence } = require('../src/auditor');
const box = "class Box { constructor(value){this.value=value} read(){return this.value} } const clean=new Box('public'), secret=new Box(process.env.TEST_TOKEN);";
const flow = source => createFlowAnalysis([{ path: 'index.js', content: source }]).analyze('index.js');
const verdict = source => auditEvidence({ sourceFiles: {
  'package.json': '{"name":"receiver-boundary","main":"index.js"}', 'index.js': source
} }).verdict;

test('explicit method receivers preserve credential flow through call/apply/Reflect.apply', () => {
  for (const expression of ['clean.read.call(secret)', 'clean.read.apply(secret,[])',
    'Reflect.apply(clean.read,secret,[])', 'clean.read.bind(secret)()']) {
    const source = `${box} fetch('/api',{body:${expression}});`;
    const result = flow(source);
    assert.ok(result.hints.some(h => h.kind === 'credential-export'), expression);
    assert.notEqual(verdict(source), 'safe', expression);
  }
});

test('first bound receiver sticks across calls, applies and later binds', () => {
  for (const expression of ['bound()', 'bound.call(clean)', 'bound.apply(clean,[])',
    'Reflect.apply(bound,clean,[])', 'bound.bind(clean)()']) {
    const source = `${box} const bound=clean.read.bind(secret); fetch('/api',{body:${expression}});`;
    assert.ok(flow(source).hints.some(h => h.kind === 'credential-export'), expression);
  }
});

test('arrow functions retain lexical this despite explicit or property receivers', () => {
  for (const expression of ['secret.read()', 'secret.read.call(clean)', 'secret.read.apply(clean,[])',
    'secret.read.bind(clean)()', 'Reflect.apply(secret.read,clean,[])', '({read:secret.read}).read()']) {
    const source = "class Box {constructor(value){this.value=value;this.read=()=>this.value}} const clean=new Box('public'), secret=new Box(process.env.TEST_TOKEN);" + `fetch('/api',{body:${expression}});`;
    assert.ok(flow(source).hints.some(h => h.kind === 'credential-export'), expression);
  }
});

test('unknown explicit receivers do not acquire complete clean coverage', () => {
  for (const expression of ['clean.read.call(unknownReceiver)', 'clean.read.apply(unknownReceiver,[])',
    'Reflect.apply(clean.read,unknownReceiver,[])', 'clean.read.bind(unknownReceiver)()']) {
    const result = flow(`${box} module.exports=${expression};`);
    assert.notEqual(result.status, 'parsed', expression);
    assert.ok(result.gaps.some(g => /receiver/.test(g.reason)), expression);
  }
});

test('explicit clean receivers and ordinary direct calls remain modeled', () => {
  for (const expression of ['clean.read()', 'secret.read.call(clean)', 'secret.read.apply(clean,[])',
    'Reflect.apply(secret.read,clean,[])', 'secret.read.bind(clean)()', 'secret.read.bind(clean).call(secret)']) {
    const result = flow(`${box} module.exports=${expression};`);
    assert.equal(result.status, 'parsed', expression);
    assert.equal(result.exports.value, 'public', expression);
    assert.equal(result.hints.some(h => h.kind === 'credential-export'), false);
  }
});


test('unresolved receiver/argument combinations and bound constructors remain incomplete', () => {
  for (const expression of ['clean.read.apply(unknownReceiver,unknownArguments)',
    'Reflect.apply(clean.read,unknownReceiver,unknownArguments)', 'new (Box.bind(clean))()',
    'Reflect.construct(Box.bind(clean),[])']) {
    const result = flow(`${box} module.exports=${expression};`);
    assert.notEqual(result.status, 'parsed', expression);
  }
});

test('binding an arrow to a secret receiver does not replace a clean lexical this', () => {
  const source = "class Box {constructor(value){this.value=value;this.read=()=>this.value}} const clean=new Box('public'), secret=new Box(process.env.TEST_TOKEN); module.exports=clean.read.bind(secret).call(secret);";
  const result = flow(source);
  assert.equal(result.status, 'parsed');
  assert.equal(result.exports.value, 'public');
});


test('instance field arrows retain uncertainty until initialization is instance-specific', () => {
  for (const [field, read] of [
    ['read=()=>this.value;', 'b.read()'],
    ['read={get:()=>this.value};', 'b.read.get()'],
    ['read=(()=>()=>this.value)();', 'b.read()']
  ]) {
    const source = `class Box {${field} constructor(value){this.value=value}} const b=new Box(process.env.TEST_TOKEN); fetch('/api',{body:${read}});`;
    const result = flow(source);
    assert.notEqual(result.status, 'parsed', field);
    assert.ok(result.gaps.some(g => /instance field (arrow|initializer)/.test(g.reason)), field);
    assert.notEqual(verdict(source), 'safe', field);
  }
});

test('factory-produced instance fields cannot claim a complete receiver model', () => {
  const source = "function make(){return ()=>this.value} class Box{read=make.call(this);constructor(value){this.value=value}} const b=new Box(process.env.TEST_TOKEN);fetch('/api',{body:b.read()});";
  assert.notEqual(flow(source).status, 'parsed');
  assert.notEqual(verdict(source), 'safe');
});

test('modeled callbacks preserve lexical and bound arrow receivers', () => {
  for (const callback of ['box.send', 'box.send.bind({})']) {
    for (const usage of [`[0].forEach(${callback})`, `Promise.resolve(0).then(${callback})`,
      `setTimeout(${callback},0)`, `const emitter=new (require('events').EventEmitter)();emitter.on('ready',${callback});emitter.emit('ready')`]) {
      for (const secret of [true, false]) {
        const source = `class Box{constructor(value){this.value=value;this.send=()=>fetch('/api',{body:this.value})}} const box=new Box(${secret ? 'process.env.TEST_TOKEN' : "'public'"});${usage};`;
        const result = flow(source);
        assert.equal(result.hints.some(h => h.kind === 'credential-export'), secret, usage);
        assert.equal(result.status, 'parsed', usage);
        if (secret) assert.notEqual(verdict(source), 'safe', usage);
      }
    }
  }
});

test('array map retains callback return taint with lexical and bound arrows', () => {
  for (const callback of ['box.read', 'box.read.bind({})']) {
    for (const secret of [true, false]) {
      const source = `class Box{constructor(value){this.value=value;this.read=()=>this.value}} const box=new Box(${secret ? 'process.env.TEST_TOKEN' : "'public'"});fetch('/api',{body:[0].map(${callback}).join('')});`;
      assert.equal(flow(source).hints.some(h => h.kind === 'credential-export'), secret, callback);
      if (secret) assert.notEqual(verdict(source), 'safe');
    }
  }
});

test('array map supplies the original array to its callback', () => {
  for (const secret of [true, false]) {
    const source = `const values=[${secret ? 'process.env.TEST_TOKEN' : "'public'"}];const read=function(value,index,list){return list[0]};fetch('/api',{body:values.map(read).join('')});`;
    assert.equal(flow(source).hints.some(h => h.kind === 'credential-export'), secret);
    if (secret) assert.notEqual(verdict(source), 'safe');
  }
});

test('array map never selects a callable thisArg as its callback', () => {
  const source = "fetch('/api',{body:[process.env.TEST_TOKEN].map(String,()=> 'public').join('')});";
  const result = flow(source);
  assert.notEqual(result.status, 'parsed');
  assert.ok(result.gaps.some(g => /unresolved array map callback/.test(g.reason)));
  assert.notEqual(verdict(source), 'safe');
  const control = "fetch('/api',{body:['public'].map(value=>value,()=> 'unused').join('')});";
  assert.equal(flow(control).status, 'parsed');
  assert.equal(verdict(control), 'safe');
});

test('regular array callbacks use the API thisArg and never their property lookup receiver', () => {
  for (const method of ['map', 'filter', 'find', 'forEach']) {
    for (const secret of [true, false]) {
      const source = `${box}clean.send=function(){fetch('/api',{body:this.value})};[0].${method}(clean.send,${secret ? 'secret' : 'clean'});`;
      assert.equal(flow(source).hints.some(h => h.kind === 'credential-export'), secret, method);
    }
  }
  assert.ok(flow(`${box}fetch('/api',{body:[0].map(clean.read,secret).join('')});`).hints.some(h => h.kind === 'credential-export'));
});

test('event callbacks use the emitter receiver and unbound callback receivers remain uncertain', () => {
  const source = `${box}const emitter=new(require('events').EventEmitter)();emitter.value=process.env.TEST_TOKEN;clean.send=function(){fetch('/api',{body:this.value})};emitter.on('ready',clean.send);emitter.emit('ready');`;
  assert.ok(flow(source).hints.some(h => h.kind === 'credential-export'));
  for (const usage of ['[0].forEach(clean.read)', 'Promise.resolve(0).then(clean.read)', 'setTimeout(clean.read,0)']) {
    assert.notEqual(flow(`${box}${usage};`).status, 'parsed', usage);
  }
  assert.notEqual(flow('Promise.resolve().then(function(value=this.value){return value});').status, 'parsed');
  const clean = flow('module.exports=[1].map(function(x){return x+1})');
  assert.equal(clean.status, 'parsed');
  assert.equal(clean.hints.length, 0);
});

test('actual stdio MCP blocks explicit secret receivers and accepts the public control', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const { start, call } = require('./helpers/mcp-load-client');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-receiver-mcp-'));
  const client = start('static', { cwd: root });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.init();
  for (const [receiver, expected] of [['secret', 'block'], ['clean', 'safe']]) {
    const response = await call(client, { packageName: 'receiver-boundary', outputFormat: 'json', sourceFiles: {
      'package.json': '{"name":"receiver-boundary","version":"1.0.0","main":"index.js"}',
      'index.js': `${box} fetch('/api',{body:clean.read.call(${receiver})});`
    } });
    assert.equal(response.result.structuredContent.verdict, expected);
  }
});
