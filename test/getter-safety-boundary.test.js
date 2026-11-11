'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');
const { sensitiveFlowHints } = require('../src/sensitive-flows');
const box = 'class Box { #value; constructor(value){this.#value=value} get value(){return this.#value} setValue(value){this.#value=value} }';
const analyze = source => createFlowAnalysis([{ path: 'index.js', content: source }]).analyze('index.js');

// Supported primitive private getters must preserve the boundaries below.
test('a primitive private getter resolves the precise receiver value', () => {
  const result = analyze(`${box} module.exports = new Box(42).value;`);
  assert.equal(result.status, 'parsed');
  assert.equal(result.exports.value, 42);
});

test('private getter reads retain secrets despite public fields with matching spellings', () => {
  for (const writes of ['', "b.value='public';", "b['#value']='public'; b.value='public';",
    "if(flag)b.setValue('public');", "if(flag)b['#value']='public';"]) {
    const source = `${box} const b=new Box(process.env.TEST_TOKEN); ${writes} fetch('/api',{body:b.value});`;
    assert.ok(sensitiveFlowHints(source).some(h => h.kind === 'credential-export'), writes);
  }
});

test('imported private getters preserve sensitive values across module boundaries', () => {
  const result = createFlowAnalysis([
    { path: 'helper.js', content: `export default ${box}` },
    { path: 'index.js', content: "import Box from './helper.js'; const b=new Box(process.env.TEST_TOKEN); b['#value']='public'; fetch('/api',{body:b.value});" }
  ]).analyze('index.js');
  assert.ok(result.hints.some(h => h.kind === 'credential-export'));
});

test('effects, public-field accessors, static accessors and inheritance retain uncertainty', () => {
  for (const source of [
    "class Box { #value; get value(){fetch('/api',{body:process.env.TEST_TOKEN}); return this.#value} }",
    "class Box { #value; get value(){return this.#value + 1} }",
    "class Box { value; get result(){return this.value} }",
    "class Box { #value; set value(value){this.#value=value} }",
    "class Box { static #value; static get value(){return this.#value} }",
    "class Box extends Unknown { #value; get value(){return this.#value} }",
    "const value={get field(){return 1}};"
  ]) assert.ok(sensitiveFlowHints(source).some(h => h.kind === 'flow-analysis-gap'), source);
});

test('class alternatives cannot erase private-field taint or claim complete analysis', () => {
  const source = "class Secret { #value=process.env.TEST_TOKEN; get value(){return this.#value} } class Public { #value='public'; get value(){return this.#value} } let b=new Secret(); if(flag)b=new Public(); fetch('/api',{body:b.value});";
  assert.ok(sensitiveFlowHints(source).some(h => ['credential-export', 'flow-analysis-gap'].includes(h.kind)));
});

test('receiver overrides retain taint and mutable object fields retain uncertainty', () => {
  for (const source of [
    `${box} const clean=new Box('public'); const secret=new Box(process.env.TEST_TOKEN); fetch('/api',{body:Reflect.get(clean,'value',secret)});`,
    "class Box { #state={value:'public'}; set(value){this.#state.value=value} get state(){return this.#state} } const a=new Box(),b=new Box(); a.set(process.env.TEST_TOKEN); b.set('public'); fetch('/api',{body:a.state.value});"
  ]) assert.ok(sensitiveFlowHints(source).some(h => ['flow-analysis-gap', 'credential-export'].includes(h.kind)), source);
});

test('relative imports inside foreign constructors preserve getter source taint', () => {
  const result = createFlowAnalysis([
    { path: 'lib/box.js', content: "export default class Box { #value; constructor(){this.#value=require('./value.js')} get value(){return this.#value} }" },
    { path: 'lib/value.js', content: 'module.exports=process.env.TEST_TOKEN;' },
    { path: 'value.js', content: "module.exports='public';" },
    { path: 'index.js', content: "import Box from './lib/box.js'; fetch('/api',{body:new Box().value});" }
  ]).analyze('index.js');
  assert.ok(result.hints.some(h => h.kind === 'credential-export'));
});

test('constructors returning replacement objects cannot silently discard their effects', () => {
  for (const body of ['return value;', 'return {value:process.env.TEST_TOKEN};', 'if(flag)return value;',
    'return /x/;', 'return /x/v;']) {
    const result = analyze(`class Box { constructor(value){${body}} } const b=new Box({value:process.env.TEST_TOKEN}); fetch('/api',{body:b.value});`);
    assert.ok(result.gaps.some(g => /constructor.*return|constructor.*replacement/.test(g.reason)), body);
  }
});

test('ordinary constructors and ignored primitive returns do not acquire replacement gaps', () => {
  for (const body of ["this.value='public';", "this.value='public'; return;", "this.value='public'; return 7;",
    "this.value='public'; return null;", "this.value='public'; return this;",
    "function helper(){return {value:'public'}} this.value='public';"]) {
    const result = analyze(`class Box { constructor(){${body}} } module.exports=new Box().value;`);
    assert.equal(result.status, 'parsed', body);
    assert.equal(result.exports.value, 'public', body);
  }
});

test('stdio MCP blocks unmodeled replacement constructors and retains ordinary classes', async t => {
  const { start, call } = require('./helpers/mcp-load-client');
  const client = start(); t.after(() => client.close());
  await client.init();
  for (const [body, expected] of [["this.value='public';", 'safe'], ['return value;', 'block']]) {
    const reply = await call(client, { outputFormat: 'json', sourceFiles: {
      'package.json': '{"name":"constructor-fixture","main":"index.js"}',
      'index.js': `class Box {constructor(value){${body}}} module.exports=new Box({value:'public'});`
    } });
    assert.equal(reply.result.structuredContent.verdict, expected);
    if (expected === 'block') assert.ok(reply.result.structuredContent.findings.some(f => f.category === 'flow-analysis-gap'));
  }
});

test('the source-only getter model never invokes inspected code', () => {
  globalThis.__pkgxrayGetterExecuted = false;
  try {
    analyze('class Box { #value; get value(){globalThis.__pkgxrayGetterExecuted=true;return this.#value} } new Box().value;');
    assert.equal(globalThis.__pkgxrayGetterExecuted, false);
  } finally { delete globalThis.__pkgxrayGetterExecuted; }
});
