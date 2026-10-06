'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { buildReviewQueue, summarizeReviewQueue, parseArgs, guardOne, summarizeValidation, buildStatsArtifact, buildReport, main } = require('../scripts/validate-at-scale');
const SCRIPT = path.resolve(__dirname, '../scripts/validate-at-scale.js');
const argv = (...args) => [process.execPath, SCRIPT, ...args];
const options = () => ({ ...parseArgs(argv()), runId: 'test-run' });
const record = (decision, findings = []) => ({ package: 'example@1.0.0', decision, findings });
const summarize = (results, expected = results.length) => summarizeValidation(options(), { length: expected }, results, new Set());

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgxray-validation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function benchmarkStub(summary, status = 0) {
  return (command, args) => command === 'git'
    ? { status: 0, stdout: 'abc123\n' }
    : { status, stdout: JSON.stringify({ summary }), stderr: 'fixture gate failed' };
}
const measured = { malicious: 3, maliciousBlocking: 2, misses: 0 };

test('numeric CLI options reject zero, fractions, NaN, and infinity', () => {
  for (const flag of ['--limit', '--concurrency', '--timeout-ms']) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '', '9007199254740992']) {
      assert.throws(() => parseArgs(argv(flag, value)), /positive integer/);
    }
    assert.throws(() => parseArgs(argv(flag)), /missing value/);
  }
  assert.throws(() => parseArgs(argv('--timeout-ms', '2147483648')), /positive integer/);
  assert.equal(parseArgs(argv('--limit', '1')).limit, 1);
});

test('default inputs match the pinned npm calibration and separate PyPI outputs', () => {
  assert.equal(options().list, path.resolve(__dirname, '../validation/calibration-2026-07-19/top1000-targets.txt'));
  assert.equal(parseArgs(argv('--ecosystem', 'pypi')).outDir, path.resolve(__dirname, '../validation/results/pypi'));
});

test('completion gate rejects empty, all-error, partial, and over-10% error runs', () => {
  assert.equal(summarize([]).gate.passed, false);
  assert.equal(summarize([record('error')]).gate.passed, false);
  assert.equal(summarize([record('safe')], 2).gate.passed, false);
  assert.equal(summarize([...Array.from({ length: 8 }, () => record('safe')), record('error')]).gate.passed, false);
  const atLimit = summarize([...Array.from({ length: 9 }, () => record('safe')), record('error')]);
  assert.equal(atLimit.gate.passed, true);
  assert.deepEqual(atLimit.completion, { expected: 10, attempted: 10, succeeded: 9, errors: 1, completionRate: 1, errorRate: 0.1, minimumSuccessfulScans: 1, maximumErrorRate: 0.1 });
  assert.equal(summarize([record('unexpected')]).completion.errors, 1);
});

test('review burden counts packages once per category and excludes failed scans', () => {
  const results = [record('allow'), record('review', [
    { severity: 'medium', category: 'metadata' },
    { severity: 'high', category: 'metadata' },
    { severity: 'info', category: 'informational' },
  ]), record('review', [{ severity: 'medium', category: 'metadata' }]), record('error')];
  const metrics = summarize(results);
  assert.deepEqual(metrics.reviewBurden, { count: 2, of: 3, rate: 0.6667, reasons: [{ category: 'metadata', packages: 2 }], resolutionTimeMinutes: null });
  assert.equal(metrics.decisions.safe, 1);
  assert.equal(summarize([]).reviewBurden.rate, null);
  const report = buildReport(options(), results.map((r) => r.package), results, 10);
  assert.match(report, /\| safe\/allow \| 1 \| 33.3% \|/);
  assert.match(report, /\| metadata \| 2 \|/);
  assert.match(report, /Validation gate: FAIL/);
});

test('candidate heuristic blocks fail the gate without claiming adjudicated false positives', () => {
  const r = record('block');
  const metrics = summarize([r]);
  assert.equal(metrics.gate.passed, false);
  assert.equal(metrics.heuristicBlockCandidates.count, 1);
  assert.equal(metrics.adjudicatedFalsePositives, null);
  assert.deepEqual(metrics.blockBreakdown, { knownVulnerability: 0, defensible: 0, heuristicCandidates: 1 });
  assert.equal(summarize([record('block', [{ category: 'known-vulnerability' }])]).gate.passed, true);
  assert.equal(summarizeValidation(options(), [r.package], [r], new Set(['example'])).gate.passed, true);
});

test('documented block classification handles pins and scopes using resolved identities', () => {
  const documented = new Set(['example', '@example/tool']);
  for (const packageName of ['example', 'example@1.2.3', '@example/tool', '@example/tool@1.2.3']) {
    const r = { ...record('block'), package: packageName };
    const summary = summarizeValidation(options(), [packageName], [r], documented);
    assert.equal(summary.blockBreakdown.defensible, 1, packageName);
    assert.equal(summary.heuristicBlockCandidates.count, 0);
    assert.equal(r.decision, 'block');
  }
  for (const [input, resolved, expected] of [
    ['alias@1.2.3', 'example', 1],
    ['example@1.2.3', 'unlisted', 0],
    ['@example/other@1.2.3', undefined, 0],
    ['example-other@1.2.3', undefined, 0],
  ]) {
    const r = { ...record('block'), package: input, resolved: resolved ? { packageName: resolved } : null };
    const summary = summarizeValidation(options(), [input], [r], documented);
    assert.equal(summary.blockBreakdown.defensible, expected, input);
  }
});

test('review queue deduplicates identical citations while retaining distinct evidence and every verdict', () => {
  const finding = { category: 'install-hook', severity: 'medium', file: 'package.json', snippet: 'documented build command', rationale: 'review required' };
  const rows = [
    { ...record('review', [finding, finding, { ...finding, file: 'nested/package.json' }]), package: 'alpha@1.0.0' },
    { ...record('review', [{ severity: 'medium', category: 'install-hook' }]), package: 'beta@1.0.0' },
    { ...record('review', [{ severity: 'info', category: 'metadata' }]), package: 'gamma@1.0.0' },
    record('safe', [finding]), record('error', [finding]), record('block', [finding]),
  ];
  const original = JSON.stringify(rows);
  const collection = { startedAt: '2026-10-04T00:00:00Z', sourceRevision: 'historical-revision', sourceTreeDirty: true, resultsSha256: 'recorded-input-hash' };
  const queue = buildReviewQueue(options(), rows, collection);
  assert.deepEqual(queue, buildReviewQueue(options(), [...rows].reverse(), collection));
  assert.equal(queue.groups.length, 2);
  assert.equal(queue.groups[0].packages.length, 2);
  assert.equal(queue.groups[0].packages[0].findings.length, 2);
  assert.equal(queue.groups[0].packages[0].evidenceStatus, 'complete');
  assert.equal(queue.groups[0].packages[1].evidenceStatus, 'unavailable');
  assert.equal(queue.groups[1].packages[0].evidenceStatus, 'unavailable');
  assert.equal(JSON.stringify(rows), original);
  const aggregate = summarizeReviewQueue(queue);
  assert.equal(aggregate.packages, 3);
  assert.deepEqual(aggregate.evidenceCoverage, { complete: 1, partial: 0, unavailable: 2 });
  assert.equal(aggregate.collection.sourceRevision, 'historical-revision');
  assert.equal(aggregate.collection.startedAt, collection.startedAt);
  assert.doesNotMatch(JSON.stringify(aggregate), /alpha@|beta@|gamma@|documented build command|nested\/package\.json/);
  assert.equal(aggregate.resolutionTimeMinutes, null);
});

test('review workflow keeps mixed categories together and measures partial or absent citations honestly', () => {
  const rows = [record('review', [
    { severity: 'high', category: 'code-execution', file: 'index.js', snippet: 'documented worker call' },
    { severity: 'medium', category: 'install-hook' },
  ]), record('review', [{ severity: 'medium', category: 'install-hook' }])];
  const summary = summarize(rows);
  assert.equal(summary.reviewBurden.count, 2);
  assert.equal(summary.decisions.review, 2);
  assert.equal(summary.reviewWorkflow.groupsCount, 2);
  assert.deepEqual(summary.reviewWorkflow.evidenceCoverage, { complete: 0, partial: 1, unavailable: 1 });
  assert.deepEqual(summary.reviewWorkflow.groups[0].categories, ['code-execution', 'install-hook']);
  assert.equal(summary.reviewWorkflow.groups[0].highestSeverity, 'high');
  assert.equal(summary.reviewWorkflow.collection.startedAt, null);
  assert.equal(summary.reviewWorkflow.groups.reduce((n, g) => n + g.packages, 0), summary.reviewBurden.count);
});

test('stats export enforces the same gates before invoking the benchmark', () => {
  const neverRun = () => { throw new Error('benchmark must not start'); };
  for (const results of [[], [record('error')], [record('block')], [record('safe'), record('error')]]) {
    assert.throws(() => buildStatsArtifact(options(), results, [], results.length, neverRun), /refusing to emit stats/);
  }
  assert.throws(() => buildStatsArtifact(options(), [record('safe')], [], 2, neverRun), /not all requested scans completed/);
});

test('stats reject a failed benchmark even when it prints parseable summary JSON', () => {
  assert.throws(() => buildStatsArtifact(options(), [record('safe')], [], 1, benchmarkStub(measured, 1)), /benchmark run failed/);
  for (const response of [{ status: null, error: new Error('spawn failed') }, { status: null, signal: 'SIGTERM' }, { status: 0, stdout: '{}' }]) {
    assert.throws(() => buildStatsArtifact(options(), [record('safe')], [], 1, () => response), /benchmark/);
  }
});

test('stats use successful denominators and null for unmeasured catch rate', () => {
  const results = [...Array.from({ length: 9 }, () => record('review')), record('error')];
  const artifact = buildStatsArtifact({ ...options(), cohort: 'mcp' }, results, [], 10, benchmarkStub({ malicious: 0, maliciousBlocking: 0, misses: 0 }));
  assert.equal(artifact.headline.packagesAttempted, 10);
  assert.equal(artifact.headline.packagesScanned, 9);
  assert.equal(artifact.headline.topThousandFalseBlocks.of, 9);
  assert.equal(artifact.headline.knownMalwareCatchRate.rate, null);
  assert.equal(artifact.reviewBurden.rate, 1);
  assert.equal(artifact.methodologyUrl, '/stats/test-run-methodology');
  assert.match(artifact.notes, /Catch rate not measured/);
  const measuredArtifact = buildStatsArtifact(options(), [record('safe')], [], 1, benchmarkStub(measured));
  assert.equal(measuredArtifact.headline.knownMalwareCatchRate.rate, 0.6667);
});

test('stats select the matching ecosystem calibration cohort', () => {
  const seen = [];
  buildStatsArtifact({ ...options(), ecosystem: 'pypi', scheme: 'pypi' }, [record('safe')], [], 1, (command, args) => {
    seen.push(args);
    return benchmarkStub(measured)(command, args);
  });
  assert.deepEqual(seen[0].slice(-2), ['--cohort', 'pypi']);
});

test('guard normalization excludes scan gaps and records resolved identities', async () => {
  function fakeGuard(body, status = 0) {
    return () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      process.nextTick(() => { child.stdout.write(JSON.stringify(body)); child.emit('close', status); });
      return child;
    };
  }
  const body = { decision: 'review', report: { findings: [{ severity: 'medium', category: 'metadata', file: 'package.json', snippet: 'benign metadata', rationale: 'inspect metadata', line: 2 }] }, resolved: { packageName: 'example', version: '1.2.3', sha256: 'abc' } };
  const resolved = await guardOne('example', 1000, 'npm', fakeGuard(body, 2));
  assert.equal(resolved.decision, 'review');
  assert.deepEqual(resolved.resolved, body.resolved);
  assert.deepEqual(resolved.findings, body.report.findings);
  assert.equal((await guardOne('example', 1000, 'npm', fakeGuard(body, null))).decision, 'error');
  assert.equal((await guardOne('example', 1000, 'npm', fakeGuard(body, 1))).decision, 'error');
  for (const response of [{ ...body, scanError: 'timeout' }, { ...body, vulnerabilityPrecheck: { error: 'OSV unavailable' } }, { decision: 'safe' }, { ...body, decision: 'unknown' }]) {
    const result = await guardOne('example', 1000, 'npm', fakeGuard(response));
    assert.equal(result.decision, 'error');
  }
});

test('ordinary CLI fails an empty corpus and invalid options without any network scan', (t) => {
  const dir = temp(t);
  const list = path.join(dir, 'empty.txt');
  fs.writeFileSync(list, '# empty\n');
  const result = spawnSync(process.execPath, [SCRIPT, '--list', list, '--out-dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'))).gate.passed, false);
  const invalid = spawnSync(process.execPath, [SCRIPT, '--concurrency', '0'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /positive integer/);
});

test('ordinary runs fail all-timeout results and never emit stats on gate failure', async (t) => {
  const dir = temp(t);
  const list = path.join(dir, 'list.txt');
  const stats = path.join(dir, 'stats.json');
  fs.writeFileSync(list, 'example@1.0.0\n');
  const code = await main(argv('--list', list, '--out-dir', dir, '--emit-stats', stats, '--run-id', 'test'), async (pkgs, concurrency, timeoutMs, scheme, onResult) => {
    onResult(record('error'));
  });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(stats), false);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json')));
  assert.equal(summary.completion.succeeded, 0);
  assert.equal(summary.gate.passed, false);
  const queue = JSON.parse(fs.readFileSync(path.join(dir, 'review-queue.json')));
  assert.deepEqual(queue.groups, []);
  assert.match(queue.collection.resultsSha256, /^[a-f0-9]{64}$/);
  assert.match(queue.collection.runnerSha256, /^[a-f0-9]{64}$/);
});
