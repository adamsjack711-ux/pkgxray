"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditEvidence } = require('../src/auditor');
const { withoutBlockListData } = require('../src/ip-policy-data');

const declaration = "const {BlockList}=require('node:net'); const deny=new BlockList();";
const denyAddress = "deny.addSubnet('100.64.0.0',10,'ipv4');";
const fetchParameter = 'function load(url) { return fetch(url); }';
const report = source => auditEvidence({ packageName: 'inert-address-policy', sourceFiles: {
  'package.json': JSON.stringify({ name: 'inert-address-policy', version: '1.0.0', main: 'index.js' }), 'index.js': source
} });
const highDestination = source => report(source).findings.some(f => f.category === 'network-exfil-or-loader' && f.severity === 'high');

test('local built-in BlockList literals are policy data, while actual same-address requests remain evidence', () => {
  assert.equal(highDestination(declaration + denyAddress + fetchParameter), false);
  assert.equal(highDestination(declaration + denyAddress + "fetch('http://100.64.0.0/data');"), true);
  assert.equal(highDestination("exports.load=()=>fetch('http://100.64.0.1/data');"), true);
  assert.equal(highDestination(declaration + "deny.addAddress('192.0.0.9','ipv4');" + fetchParameter), false);
  assert.equal(highDestination(declaration + "deny.addAddress('192.0.0.9','ipv4');fetch('http://192.0.0.9/data');"), true);
});

test('exact non-escaping ESM literal subnet tables do not become destination claims', () => {
  const source = `import {BlockList} from 'node:net';
const deny=new BlockList();
for (const [network,prefix] of [['100.64.0.0',10],['192.0.2.0',24]]) { deny.addSubnet(network,prefix,'ipv4'); }
export const load=url=>fetch(url);`;
  assert.equal(highDestination(source), false);
  assert.equal(highDestination(source.replace("deny.addSubnet(network,prefix,'ipv4');", "deny.addSubnet(network,prefix,'ipv4'); fetch('http://'+network);")), true);
  assert.equal(highDestination(source + "fetch('http://100.64.0.0/data');"), true);
});

test('unknown constructors, mutation, aliases, shadowing and escaping objects retain IP evidence', () => {
  for (const source of [
    "const BlockList=class {}; const deny=new BlockList();" + denyAddress + fetchParameter,
    declaration + "deny.addSubnet=fetch;" + denyAddress + fetchParameter,
    declaration + "BlockList.prototype.addSubnet=fetch;" + denyAddress + fetchParameter,
    declaration + "const alias=deny;" + denyAddress + fetchParameter,
    declaration + "exports.deny=deny;" + denyAddress + fetchParameter,
    declaration + "Object.setPrototypeOf(deny,{});" + denyAddress + fetchParameter,
    declaration + "function f(deny){" + denyAddress + "}" + fetchParameter,
    declaration + "function f(require){}" + denyAddress + fetchParameter,
    declaration + "require('node:net').BlockList.prototype.addSubnet=fetch;" + denyAddress + fetchParameter,
    declaration + "eval('modify');" + denyAddress + fetchParameter,
    "const name='node:n';const extra=require(name+'et');extra['BlockList'].prototype.addSubnet=ip=>fetch('http://'+ip);" + declaration + denyAddress,
    "const extra=require(String.fromCharCode(110,101,116));extra['BlockList'].prototype.addSubnet=ip=>fetch('http://'+ip);" + declaration + denyAddress,
    "let mod='n';mod+='et';let key='proto';key+='type';let method='getBuiltin';method+='Module';const extra=process[method](mod);extra['BlockList'][key]['addSubnet']=ip=>fetch('http://'+ip);" + declaration + denyAddress,
    "const deny={addSubnet:fetch};" + denyAddress + fetchParameter,
    declaration + "deny['addSubnet']('100.64.0.0',10,'ipv4');" + fetchParameter,
    // Unrelated member writes stay outside the narrow exception too.
    declaration + denyAddress + 'exports.load=url=>fetch(url);'
  ]) assert.equal(highDestination(source), true, source);
});

test('modified prototype or iteration cannot hide network use of a policy-shaped table', () => {
  const source = `import {BlockList} from 'node:net';
const original=Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator]=function*(){fetch('http://'+this[0][0]);yield* original.call(this);};
const deny=new BlockList();
for(const [network,prefix] of [['100.64.0.0',10]]){deny.addSubnet(network,prefix,'ipv4');}`;
  assert.equal(highDestination(source), true);
  assert.equal(withoutBlockListData(source), source);
});

test('policy-data recognition stays bounded and retains unsupported source', () => {
  const source = declaration + denyAddress + fetchParameter;
  for (const input of [source + ' invalid !!!', source + ' '.repeat(128 * 1024)]) assert.equal(withoutBlockListData(input), input);
  assert.equal(withoutBlockListData(source).length, source.length);
  assert.ok(withoutBlockListData(source).includes(fetchParameter));
});
