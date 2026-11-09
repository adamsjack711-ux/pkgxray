// Reduced authentication-shaped controls, not jose or Tapp implementations.
// Synthetic source only: no JWT verification and no target code execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeProject } from '../src/analyze.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-ray-esm-demo-'));
const write = (file, data) => {
  const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
};
try {
  const manifest = { name: 'synthetic-auth-demo', version: '1.0.0', type: 'module', dependencies: { 'key-client': '1.0.0' } };
  write('package.json', manifest);
  write('package-lock.json', { lockfileVersion: 3, packages: { '': manifest, 'node_modules/key-client': { version: '1.0.0' } } });
  write('node_modules/key-client/package.json', { name: 'key-client', version: '1.0.0', type: 'module',
    exports: { '.': { types: './index.d.ts', import: './index.js' } } });
  write('node_modules/key-client/index.js', 'export {requestKeys} from "./request.js";');
  write('entry.mjs', 'import {requestKeys} from "key-client";requestKeys(process.env.IDENTITY_TOKEN);');
  const cases = [
    ['Public-key request without the token', 'export function requestKeys(token){fetch("https://keys.example.invalid/jwks");}', 'no-flow-found'],
    ['Token deliberately included in request', 'export function requestKeys(token){fetch("https://keys.example.invalid/jwks",{headers:{Authorization:"Bearer "+token}});}', 'review'],
    ['Async path remains unsupported', 'export async function requestKeys(token){await fetch("https://keys.example.invalid/jwks",{body:token});}', 'incomplete'],
  ];
  for (const [label, source, expected] of cases) {
    write('node_modules/key-client/request.js', source);
    const report = analyzeProject({ root, entry: 'entry.mjs' });
    assert.equal(report.verdict, expected, JSON.stringify(report.gaps));
    console.log(`${report.verdict.padEnd(13)} ${label} (${report.findings.length} flow(s), ${report.stats.modules} modules)`);
  }
  console.log('Synthetic ESM controls only; this does not establish Tapp or jose security.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
