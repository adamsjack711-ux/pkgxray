'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlowAnalysis } = require('../src/flow-analysis');

const link = 'class Link {value;next;constructor(value){this.value=value}}';
function queue(extra = '', create = 'new Link(value)') {
  return `class Queue{#head;#tail;#size=0;get size(){return this.#size}append(value){const node=${create};if(this.#head){this.#tail.next=node;this.#tail=node}else{this.#head=node;this.#tail=node}}${extra}}`;
}
function analyze(source) {
  return createFlowAnalysis([{ path: 'index.js', content: source }]).analyze('index.js');
}
function held(source, label) {
  const result = analyze(source);
  assert.ok(result.status !== 'parsed' || result.hints.some(h => h.kind === 'credential-export'),
    `${label}: unknown or secret-bearing private state was cleared (${JSON.stringify({ status: result.status, hints: result.hints, gaps: result.gaps })})`);
}

test('closed private links backed by an inert local data class retain complete coverage', () => {
  for (const extra of ['', 'first(){return this.#head.value}', 'clear(){this.#head=undefined;this.#tail=undefined}']) {
    const result = analyze(link + queue(extra) + 'module.exports=Queue;');
    assert.equal(result.status, 'parsed', JSON.stringify(result.gaps));
    assert.equal(result.hints.some(h => h.kind === 'credential-export'), false);
  }
});

// These negatives must not be weakened merely because a field sometimes holds
// an instance of a known class.
test('an externally assignable private tail does not acquire a closed local shape', () => {
  held(link + queue('setTail(value){this.#tail=value}') + 'const q=new Queue();q.setTail(unknownTail);q.append(1);', 'external tail');
});

test('factory-produced and unknown constructor results do not establish link shape', () => {
  for (const create of ['makeLink(value)', 'new UnknownLink(value)', 'flag?new Link(value):unknownLink']) {
    held(link + queue('', create) + 'const q=new Queue();q.append(1);q.append(2);', create);
  }
});

test('link accessors and prototype mutations cannot be treated as inert data writes', () => {
  const accessor = 'class Link{value;constructor(value){this.value=value}set next(node){fetch("/api",{body:node.value})}}';
  held(accessor + queue() + 'const q=new Queue();q.append(0);q.append(process.env.TEST_TOKEN);', 'declared setter');
  for (const mutation of [
    "Object.defineProperty(Link.prototype,'next',{set(node){fetch('/api',{body:node.value})}});",
    "Object.defineProperties(Link.prototype,{next:{set(node){fetch('/api',{body:node.value})}}});",
    "Reflect.defineProperty(Link.prototype,'next',{set(node){fetch('/api',{body:node.value})}});",
    "Object.setPrototypeOf(Link.prototype,{set next(node){fetch('/api',{body:node.value})}});"
  ]) held(link + queue() + mutation + 'const q=new Queue();q.append(0);q.append(process.env.TEST_TOKEN);', mutation);
});

test('escaped internal links cannot retain an unqualified inert property-write proof', () => {
  for (const escape of ['return this.#tail;', 'external(this.#tail);']) {
    held(link + queue(`expose(){${escape}}`) + "const q=new Queue();q.append(0);const tail=q.expose();Object.defineProperty(tail,'next',{set(node){fetch('/api',{body:node.value})}});q.append(process.env.TEST_TOKEN);", escape);
  }
});

test('a nonprimitive private getter does not gain primitive getter authorization from local shape', () => {
  held(link + queue('get head(){return this.#head}') + "const q=new Queue();q.append(process.env.TEST_TOKEN);fetch('/api',{body:q.head.value});", 'nonprimitive head getter');
});

test('secret insertion followed by a later private-state read remains detected or unresolved', () => {
  for (const read of [
    'first(){return this.#head.value}',
    'first(){const node=this.#head;return node.value}',
    'first(){return this.#tail.value}'
  ]) held(link + queue(read) + "const q=new Queue();q.append(process.env.TEST_TOKEN);fetch('/api',{body:q.first()});", read);
});

test('branch-written external tails cannot disappear when a local shape is merged', () => {
  held(link + queue('setTail(value){if(flag)this.#tail=value}') + 'const q=new Queue();q.append(0);q.setTail(unknownTail);q.append(1);', 'branch external write');
});

test('undefined or constructor name shadowing cannot establish a closed private shape', () => {
  for (const extra of [
    'replace(undefined){this.#tail=undefined}',
    'replace({value:undefined}){this.#tail=undefined}',
    'replace([undefined]){this.#tail=undefined}',
    'replace(undefined=unknownTail){this.#tail=undefined}',
    'replace(...undefined){this.#tail=undefined}',
    'replace(){const undefined=unknownTail;this.#tail=undefined}',
    'replace(){const {value:undefined}=unknown;this.#tail=undefined}',
    'replace(){try{external()}catch(undefined){this.#tail=undefined}}',
    'replace(Link){this.#tail=new Link(1)}',
    'replace(){const Link=UnknownLink;this.#tail=new Link(1)}'
  ]) held(link + queue(extra) + 'module.exports=Queue;', extra);
});

test('private link escapes through data assignments or local aliases retain uncertainty', () => {
  for (const extra of [
    'expose(){external.tail=this.#tail}',
    "expose(){external['tail']=this.#tail}",
    'expose(){this.publicTail=this.#tail}',
    'expose(){const alias=this.#tail;external.tail=alias}',
    'expose(){const alias=this.#tail;return alias}',
    'expose(){const alias=this.#tail;external(alias)}',
    'expose(){const alias=this.#tail;delete alias.next}',
    'replace(value){this.#tail.next=value}'
  ]) held(link + queue(extra) + 'module.exports=Queue;', extra);
});

test('shape proof does not replace actual private state populated by constructed instances', () => {
  for (const secret of [true, false]) {
    const result = analyze(link + queue('first(){return this.#head.value}') + `const q=new Queue();q.append(${secret ? 'process.env.TEST_TOKEN' : "'public'"});fetch('/api',{body:q.first()});`);
    assert.equal(result.hints.some(h => h.kind === 'credential-export'), secret);
    // Real receiver branches may remain uncertain; the dormant-only proof is
    // not permission to replace their state with clean shape data.
  }
});
