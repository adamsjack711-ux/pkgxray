'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');

const box = 'class Box { #value; constructor(value){this.#value=value} get value(){return this.#value} setValue(value){this.#value=value} }';
const sink = expression => `fetch('/api',{body:${expression}});`;
function analyze(input) {
  const files = typeof input === 'string' ? { 'index.js': input } : input;
  return createFlowAnalysis(Object.entries(files).map(([path, content]) => ({ path, content }))).analyze('index.js');
}
function held(input, label) {
  const result = analyze(input);
  assert.ok(result.status !== 'parsed' || result.hints.some(h => h.kind === 'credential-export'),
    `${label}: secret-bearing or unsupported access cannot claim complete clean analysis (${JSON.stringify({ status: result.status, hints: result.hints, gaps: result.gaps })})`);
}

test('supported primitive private getter controls preserve complete clean analysis', () => {
  for (const source of [
    `${box} module.exports=new Box('public').value;`,
    "class Box { #value=42; get value(){return this.#value} } module.exports=new Box().value;"
  ]) {
    const result = analyze(source);
    assert.equal(result.status, 'parsed');
    assert.equal(result.hints.some(h => h.kind === 'credential-export'), false);
  }
});

test('public spellings and readonly writes cannot clear private getter secrets', () => {
  for (const mutation of [
    "b['#value']='public';", "b.other='public';",
    "try{b.value='public'}catch(error){}",
    "const alias=b;try{alias.value='public'}catch(error){}",
    "let alias=b;if(flag)alias=b;try{alias['value']='public'}catch(error){}",
    "if(flag)b.setValue('public');", "if(flag)b['#value']='public';",
    "try{Reflect.set(b,'value','public')}catch(error){}"
  ]) held(`${box}const b=new Box(process.env.TEST_TOKEN);${mutation}${sink('b.value')}`, mutation);
});

test('private brands remain distinct across class declarations and branch joins', () => {
  const classes = "class Secret{#value;constructor(value){this.#value=value}get value(){return this.#value}} class Public{#value;constructor(value){this.#value=value}get value(){return this.#value}}";
  for (const tail of [
    "const a=new Secret(process.env.TEST_TOKEN);const b=new Public('public');fetch('/api',{body:a.value});",
    "let a=new Secret(process.env.TEST_TOKEN);if(flag)a=new Public('public');fetch('/api',{body:a.value});",
    "const a=new Secret(process.env.TEST_TOKEN);const b=new Public('public');fetch('/api',{body:Reflect.get(b,'value',a)});"
  ]) held(classes + tail, tail);
});

test('same-named imported classes retain their own private field identity', () => {
  for (const expression of ['a.value', "Reflect.get(b,'value',a)"]) held({
    'secret.js': `module.exports=${box}`,
    'public.js': `module.exports=${box}`,
    'index.js': `const A=require('./secret'),B=require('./public');const a=new A(process.env.TEST_TOKEN),b=new B('public');${sink(expression)}`
  }, expression);
});

test('nested class declarations cannot replace an enclosing class private-name binding', () => {
  held("class Outer{#value;constructor(value){this.#value=value}get value(){return this.#value}make(){return class Inner{#value='public';get value(){return this.#value}}}}const a=new Outer(process.env.TEST_TOKEN);const Inner=a.make();const b=new Inner();fetch('/api',{body:a.value});", 'nested private-name shadowing');
});

test('repeated evaluation of one class expression does not share a private brand', () => {
  const source = "function factory(){return class Box{#value='public';get value(){return this.#value}}}const A=factory(),B=factory();const a=new A(),b=new B();module.exports=Reflect.get(b,'value',a);";
  assert.notEqual(analyze(source).status, 'parsed', 'same class syntax evaluated twice has distinct brands');
});

test('getter alternative limits cannot discard a secret in a later class branch', () => {
  const declarations = Array.from({ length: 20 }, (_, index) =>
    `class Box${index}{#value=${index === 19 ? 'process.env.TEST_TOKEN' : "'public'"};get value(){return this.#value}}`).join('');
  const joins = Array.from({ length: 19 }, (_, index) =>
    `if(flag${index + 1})b=new Box${index + 1}();`).join('');
  held(`${declarations}let b=new Box0();${joins}${sink('b.value')}`, 'twentieth getter alternative');
});

test('imported primitive getters keep defining-module loads and caller decoys separate', () => {
  for (const secret of [true, false]) {
    const result = analyze({
      'lib/box.js': "module.exports=class Box{#value;constructor(){this.#value=require('./value')}get value(){return this.#value}}",
      'lib/value.js': `module.exports=${secret ? 'process.env.TEST_TOKEN' : "'public'"};`,
      'value.js': "module.exports='caller-decoy';",
      'index.js': "const Box=require('./lib/box');fetch('/api',{body:new Box().value});"
    });
    if (secret) assert.ok(result.status !== 'parsed' || result.hints.some(h => h.kind === 'credential-export'));
    else { assert.equal(result.status, 'parsed'); assert.equal(result.hints.some(h => h.kind === 'credential-export'), false); }
  }
});

test('two instances cannot overwrite each other through private object fields', () => {
  for (const field of ["#state={value:'public'};", "#state;constructor(){this.#state={value:'public'}}"]) {
    const source = `class Box{${field}set(value){this.#state.value=value}get state(){return this.#state}}const a=new Box(),b=new Box();a.set(process.env.TEST_TOKEN);b.set('public');${sink('a.state.value')}`;
    held(source, field);
  }
});

test('shared external field aliases cannot be mistaken for fresh private instance storage', () => {
  held("const shared={value:'public'};class Box{#state=shared;get state(){return this.#state}}const a=new Box(),b=new Box();shared.value=process.env.TEST_TOKEN;fetch('/api',{body:a.state.value});", 'shared external initializer');
  held("const shared={value:'public'};class Box{#state;constructor(value){this.#state=value}get state(){return this.#state}}const a=new Box(shared);shared.value=process.env.TEST_TOKEN;fetch('/api',{body:a.state.value});", 'constructor object alias');
});

test('own data fields shadow prototype getters without erasing the own secret', () => {
  for (const members of [
    "#inner='public';value=process.env.TEST_TOKEN;get value(){return this.#inner}",
    "#inner='public';get value(){return this.#inner}value=process.env.TEST_TOKEN;"
  ]) held(`class Box{${members}}${sink('new Box().value')}`, members);
});

test('per-instance closures and nested private values remain detected or unresolved', () => {
  for (const body of [
    "#read;constructor(value){this.#read=()=>value}get read(){return this.#read}",
    "#value;constructor(value){this.#value=value}#read=()=>this.#value;get read(){return this.#read}",
    "#state;constructor(value){this.#state={read:()=>value}}get read(){return this.#state}"
  ]) {
    const read = body.includes('{read:') ? 'a.read.read()' : 'a.read()';
    held(`class Box{${body}}const a=new Box(process.env.TEST_TOKEN),b=new Box('public');${sink(read)}`, body);
  }
});

test('dormant exported methods cannot clear cross-method private state flow', () => {
  for (const methods of [
    "capture(){this.#value=process.env.TEST_TOKEN}send(){fetch('/api',{body:this.value})}",
    "capture(){this.#value={token:process.env.TEST_TOKEN}}send(){fetch('/api',{body:this.value.token})}",
    "set(value){this.#value=value}capture(){this.set(process.env.TEST_TOKEN)}send(){fetch('/api',{body:this.value})}"
  ]) held(`module.exports=class Box{#value='public';get value(){return this.#value}${methods}};`, methods);
});

test('Reflect.get uses its explicit receiver and cannot default to the clean target', () => {
  held(`${box}const a=new Box('public'),b=new Box(process.env.TEST_TOKEN);${sink("Reflect.get(a,'value',b)")}`, 'explicit secret receiver');
  for (const receiver of ['unknownReceiver', '{}', "{value:'public'}"]) {
    held(`${box}const a=new Box('public');${sink(`Reflect.get(a,'value',${receiver})`)}`, receiver);
  }
  const clean = analyze(`${box}const a=new Box(process.env.TEST_TOKEN),b=new Box('public');module.exports=Reflect.get(a,'value',b);`);
  assert.equal(clean.status, 'parsed');
  assert.equal(clean.exports.value, 'public');
});

test('deletion, reflection and descriptor extraction cannot erase getter uncertainty or secret flow', () => {
  for (const action of [
    "delete b.value;fetch('/api',{body:b.value});",
    "Object.defineProperty(b,'unrelated',{value:'public'});fetch('/api',{body:b.value});",
    "const read=Object.getOwnPropertyDescriptor(Box.prototype,'value').get;fetch('/api',{body:read.call(b)});",
    "const read=Reflect.getOwnPropertyDescriptor(Box.prototype,'value').get;fetch('/api',{body:Reflect.apply(read,b,[])});",
    "const proto=Object.getPrototypeOf(b);const read=Object.getOwnPropertyDescriptor(proto,'value').get;fetch('/api',{body:read.call(b)});",
    "Object.defineProperty(b,'value',{get(){return process.env.TEST_TOKEN}});fetch('/api',{body:b.value});"
  ]) held(`${box}const b=new Box(process.env.TEST_TOKEN);${action}`, action);
});

test('property shadow removal exposes the original getter instead of an old clean value', () => {
  held(`${box}const b=new Box(process.env.TEST_TOKEN);Object.defineProperty(b,'value',{value:'public',configurable:true});delete b.value;${sink('b.value')}`, 'shadow then delete');
});

test('deletion still analyzes computed property-key effects without reading a getter', () => {
  for (const setup of ['const object={};', "class Box{#value='public';get value(){return this.#value}}const object=new Box();"]) {
    const result = analyze(setup + "delete object[fetch('/api',{body:process.env.TEST_TOKEN})];");
    assert.ok(result.hints.some(h => h.kind === 'credential-export'));
  }
  const clean = analyze("const object={value:'public'};delete object['value'];");
  assert.equal(clean.status, 'parsed');
  assert.equal(clean.hints.some(h => h.kind === 'credential-export'), false);
});

test('rewritten property assignments retain ambient object writes across later reads', () => {
  for (const object of ['globalThis', 'global']) {
    const secret = analyze(`${object}.saved=process.env.TEST_TOKEN;fetch('/api',{body:${object}.saved});`);
    assert.ok(secret.hints.some(h => h.kind === 'credential-export'), object);
    const clean = analyze(`${object}.saved='public';fetch('/api',{body:${object}.saved});`);
    assert.equal(clean.status, 'parsed');
    assert.equal(clean.hints.some(h => h.kind === 'credential-export'), false);
  }
});

test('prototype and descriptor changes cannot preserve stale clean getter authority', () => {
  const cleanBox = "class Box{#value='public';get value(){return this.#value}}const b=new Box();";
  for (const mutation of [
    "Object.defineProperty(Box.prototype,'value',{get(){return process.env.TEST_TOKEN}});",
    "Reflect.defineProperty(b,'value',{get(){return process.env.TEST_TOKEN}});",
    "Object.defineProperties(b,{value:{get(){return process.env.TEST_TOKEN}}});",
    "Object.setPrototypeOf(b,{get value(){return process.env.TEST_TOKEN}});",
    "b.__proto__={get value(){return process.env.TEST_TOKEN}};"
  ]) held(cleanBox + mutation + sink('b.value'), mutation);
});

test('container reflection and copies preserve the identity of contained getter instances', () => {
  for (const expression of [
    "Object.values({b})[0].value", "Object.entries({b})[0][1].value",
    "({...{b}}).b.value", "Object.assign({}, {b}).b.value",
    "(flag?{b}:{b}).b.value", "b[unknownKey]"
  ]) held(`${box}const b=new Box(process.env.TEST_TOKEN);${sink(expression)}`, expression);
});

test('copying a nested getter instance cannot hide later alias mutation behind clean taint bits', () => {
  for (const [container, target, output] of [
    ['{b}', 'copy.b', '{}'],
    ['{holder:{b}}', 'copy.holder.b', '{}'],
    ['[b]', 'copy[0]', '[]'],
    ['{holder:[b]}', 'copy.holder[0]', '{}']
  ]) {
    const source = `class Box{#value='public';get value(){return this.#value}}const b=new Box();const copy=Object.assign(${output},${container});Object.defineProperty(${target},'value',{get:()=>process.env.TEST_TOKEN});${sink('b.value')}`;
    held(source, container);
  }
});

test('constructor replacement, inheritance and accessor effects remain bounded uncertainty', () => {
  for (const source of [
    "class Box{#value='public';get value(){return this.#value}constructor(value){return value}}const b=new Box({value:process.env.TEST_TOKEN});fetch('/api',{body:b.value});",
    "class Base{#value;constructor(value){this.#value=value}get value(){return this.#value}}class Box extends Base{}fetch('/api',{body:new Box(process.env.TEST_TOKEN).value});",
    "class Box{#value='public';get value(){fetch('/api',{body:process.env.TEST_TOKEN});return this.#value}}new Box().value;"
  ]) held(source, source);
});

test('getter reads through computed keys, destructuring and aliases preserve secret evidence', () => {
  for (const action of [
    "const alias=b;fetch('/api',{body:alias.value});",
    "const {value}=b;fetch('/api',{body:value});",
    "const {value:renamed}=b;fetch('/api',{body:renamed});",
    "const key='value';fetch('/api',{body:b[key]});",
    "fetch('/api',{body:Reflect.get(b,'value')});"
  ]) held(`${box}const b=new Box(process.env.TEST_TOKEN);${action}`, action);
});

test('adversarial getter sources are analyzed without executing them', () => {
  globalThis.__pkgxrayAdversarialGetterExecuted = false;
  try {
    held("class Box{#value='public';get value(){globalThis.__pkgxrayAdversarialGetterExecuted=true;return process.env.TEST_TOKEN}}fetch('/api',{body:new Box().value});", 'execution sentinel');
    assert.equal(globalThis.__pkgxrayAdversarialGetterExecuted, false);
  } finally { delete globalThis.__pkgxrayAdversarialGetterExecuted; }
});
