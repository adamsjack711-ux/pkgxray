'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildReport } = require('../scripts/validate-at-scale');

const options = { ecosystem: 'npm', list: path.join(__dirname, '../src/data/top1000.txt'), concurrency: 1 };
const record = (decision, findings = []) => ({ package: 'fixture@1.0.0', decision, findings });

test('validation summary counts both guard allow and audit safe without claiming a full corpus run', () => {
  const records = [record('allow'), record('safe'), record('review'), record('error')];
  const report = buildReport(options, ['a', 'b', 'c', 'd'], records, 1000);
  assert.match(report, /4 selected npm packages/);
  assert.match(report, /\| safe\/allow \| 2 \| 50\.0% \|/);
  assert.match(report, /\| review \| 1 \| 25\.0% \|/);
  assert.match(report, /\| error\/unresolved \| 1 \| 25\.0% \|/);
});

test('validation review reasons count affected packages rather than per-file findings', () => {
  const gap = { category: 'flow-analysis-gap', severity: 'medium' };
  const report = buildReport(options, ['a', 'b'], [
    record('review', [gap, gap, gap, { category: 'info-only', severity: 'info' }]),
    record('review', [gap])
  ], 1000);
  assert.match(report, /\| flow-analysis-gap \| 2 \|/);
  assert.doesNotMatch(report, /\| flow-analysis-gap \| 4 \|/);
  assert.doesNotMatch(report, /\| info-only \|/);
});
