#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { auditEvidence } = require("../../src/auditor");
function evaluate(holdout = false) {
  const bytes = fs.readFileSync(path.join(__dirname, holdout ? "holdout.json" : "cases.json"));
  const corpus = JSON.parse(bytes);
  const ids = new Set();
  const results = corpus.cases.map(c => {
    if (!c.id || ids.has(c.id) || !['malicious', 'benign'].includes(c.label) || !c.family || !c.rationale) throw new Error('Invalid or duplicate challenge case');
    ids.add(c.id);
    const report = auditEvidence(c.evidence);
    if (!['safe', 'review', 'block'].includes(report.verdict)) throw new Error('Invalid engine verdict');
    const outcome = c.label === 'malicious' ? { safe: 'MISS', review: 'REVIEW', block: 'BLOCK' }[report.verdict]
      : { safe: 'CLEAR', review: 'REVIEW', block: 'FALSE_BLOCK' }[report.verdict];
    return { id: c.id, family: c.family, label: c.label, variant: c.variant, verdict: report.verdict, outcome,
      categories: [...new Set(report.findings.map(f => f.category))].sort() };
  });
  const summarize = entries => Object.fromEntries(['MISS', 'FALSE_BLOCK', 'REVIEW', 'BLOCK', 'CLEAR'].map(k => [k, entries.filter(r => r.outcome === k).length]));
  return { schemaVersion: 1, corpusSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    cases: results.length, families: new Set(results.map(r => r.family)).size,
    note: 'Paired synthetic cases; filename variants are correlated, not independent observations. REVIEW is not BLOCK.',
    summary: summarize(results), byVariant: Object.fromEntries([...new Set(results.map(r => r.variant))].map(v => [v, summarize(results.filter(r => r.variant === v))])), results };
}
function compareBaseline(report, baseline) {
  if (report.corpusSha256 !== baseline.corpusSha256 || report.results.length !== baseline.results.length) return ['corpus changed: requires explicit relabel/review'];
  const rank = { safe: 0, review: 1, block: 2 };
  const old = new Map(baseline.results.map(r => [r.id, r]));
  return report.results.filter(r => !old.has(r.id) || (r.label === 'malicious'
    ? rank[r.verdict] < rank[old.get(r.id).verdict] : rank[r.verdict] > rank[old.get(r.id).verdict])).map(r => r.id);
}
if (require.main === module) {
  const holdout = process.argv.includes("--holdout");
  const report = evaluate(holdout);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.cases} synthetic cases / ${report.families} families`);
    console.log(report.note);
    console.table(report.byVariant);
    for (const r of report.results.filter(r => ['MISS', 'FALSE_BLOCK'].includes(r.outcome))) console.log(`${r.outcome}: ${r.id}`);
  }
  if (process.argv.includes('--check-baseline')) {
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, holdout ? 'flow-holdout-results.json' : 'audit-results.json'), 'utf8'));
    const regressions = compareBaseline(report, baseline);
    if (regressions.length) console.error('REGRESSIONS:', regressions.join(', '));
    else console.error(`Baseline retained; ${report.summary.MISS} SAFE misses and ${report.summary.FALSE_BLOCK} false blocks in this synthetic corpus. This is not a real-world accuracy estimate.`);
    process.exitCode = regressions.length ? 1 : 0;
  } else process.exitCode = report.summary.MISS || report.summary.FALSE_BLOCK ? 1 : 0;
}
module.exports = { evaluate, compareBaseline };
