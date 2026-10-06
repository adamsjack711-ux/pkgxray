'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, compareBaseline } = require('../benchmark/adversarial/run');

test('frozen challenges retain their per-case baseline without disguising known misses', () => {
  for (const holdout of [false, true]) {
    const report = evaluate(holdout);
    const baseline = require(`../benchmark/adversarial/${holdout ? 'flow-holdout-results' : 'audit-results'}.json`);
    assert.deepEqual(compareBaseline(report, baseline), []);
    assert.equal(report.summary.MISS, 0, 'frozen known misses must stay detected');
    assert.equal(report.summary.FALSE_BLOCK, 0);
  }
});
test('audit baseline records only the eight reviewed lexical-coverage changes', () => {
  const previous = require('../benchmark/adversarial/flow-results.json');
  const current = require('../benchmark/adversarial/audit-results.json');
  assert.equal(previous.corpusSha256, current.corpusSha256);
  const changed = current.results.filter((r, i) => r.verdict !== previous.results[i].verdict);
  assert.equal(changed.length, 8);
  for (const r of changed) {
    const old = previous.results.find(v => v.id === r.id);
    assert.equal(r.label, 'benign'); assert.equal(old.verdict, 'safe'); assert.equal(r.verdict, 'review');
    assert.deepEqual(r.categories, ['flow-analysis-gap', ...old.categories].sort());
  }
});
test('baseline check rejects a new malicious miss, benign overflag and changed corpus', () => {
  const baseline = evaluate();
  const report = structuredClone(baseline);
  report.results.find(r => r.label === 'malicious' && r.verdict !== 'safe').verdict = 'safe';
  report.results.find(r => r.label === 'benign' && r.verdict === 'safe').verdict = 'review';
  assert.equal(compareBaseline(report, baseline).length, 2);
  report.corpusSha256 = 'changed';
  assert.match(compareBaseline(report, baseline)[0], /corpus changed/);
});
