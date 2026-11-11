'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { selectCases, digest } = require('../scripts/validate-external-corpus');
const { selectExpanded, freezeArchiveIdentities, validateManifest, evaluateFrozen, evaluateRecords, summarize,
  identitySummary, guardObservation, blobHash, BOUNDS, ALLOCATION } = require('../scripts/validate-broad-malicious');
const manifest = require('../benchmark/broad-malicious-manifest.json');
const original = require('../benchmark/external-four-controls-validation-2026-11-11.json').cases.filter(c => c.label === 'malicious');

function syntheticTrees() {
  const entries = count => Array.from({ length: count }, (_, i) => ({ type: 'blob', size: 64,
    sha: digest(Buffer.from(String(i)), 'sha1'), path: `fixture-${i}/1.0.0/2024-01-01-fixture.zip` }));
  return { compromised_lib: { truncated: false, tree: entries(4) },
    malicious_intent: { truncated: false, tree: entries(40) } };
}

test('expanded selection preserves each original rank prefix and transparently fills category shortfall', () => {
  const trees = syntheticTrees(), selected = selectExpanded(trees);
  assert.equal(selected.length, 32);
  for (const category of Object.keys(ALLOCATION)) {
    const cases = selected.filter(record => record.category === category);
    assert.equal(cases.length, ALLOCATION[category]);
    assert.deepEqual(cases.slice(0, 4).map(record => record.sourcePath), selectCases(trees[category], category, 4).map(record => record.sourcePath));
    assert.deepEqual(cases.map(record => record.sourcePath), selectCases(trees[category], category, ALLOCATION[category]).map(record => record.sourcePath));
    assert.equal(new Set(cases.map(record => record.packageName)).size, cases.length);
  }
  const reversed = structuredClone(trees);
  for (const tree of Object.values(reversed)) tree.tree.reverse();
  assert.deepEqual(selectExpanded(reversed), selected);
  assert.throws(() => selectExpanded({ ...trees, compromised_lib: { ...trees.compromised_lib, truncated: true } }), /truncated/);
  assert.throws(() => selectExpanded({ ...trees, malicious_intent: { tree: trees.malicious_intent.tree.slice(0, 8) } }), /Insufficient/);
});

test('committed frozen manifest keeps original eight archives unchanged and all thirty-two cases', () => {
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(manifest.scansPerformed, 0);
  assert.deepEqual(manifest.allocation, { compromised_lib: 4, malicious_intent: 28 });
  assert.deepEqual(manifest.requestedAllocation, { compromised_lib: 16, malicious_intent: 16 });
  assert.equal(manifest.availableEligibleCases.compromised_lib, 4);
  assert.equal(manifest.cases.length, 32);
  assert.deepEqual(manifest.cases.filter(record => record.originalCohort).map(record => [record.sourcePath, record.zipSha256]),
    original.map(record => [record.sourcePath, record.zipSha256]));
  assert.equal(manifest.identities.originalArchiveComparisons.filter(record => record.status === 'unchanged').length, 8);
  assert.match(manifest.identities.familyOrCampaignIndependence, /Unknown/);
  assert.deepEqual(manifest.bounds, BOUNDS);
});

test('archive freezing retains acquisition errors without selecting or scanning replacements', async () => {
  const bytes = Buffer.from('inert archive identity fixture');
  const selected = selectExpanded(syntheticTrees()).slice(0, 3).map(record => ({ ...record,
    zipBytes: bytes.length, blobSha1: blobHash(bytes) }));
  const urls = [], observed = [];
  const frozen = await freezeArchiveIdentities(selected, { request: async (url, limit) => {
    urls.push(url); assert.equal(limit, 4 * 1024 * 1024);
    if (urls.length === 2) throw new Error('acquisition unavailable');
    return bytes;
  }, onCase: record => observed.push(record.sourcePath) });
  assert.equal(urls.length, 3);
  assert.deepEqual(frozen.map(record => record.sourcePath), selected.map(record => record.sourcePath));
  assert.deepEqual(observed, selected.map(record => record.sourcePath));
  assert.equal(frozen[0].zipSha256, digest(bytes));
  assert.equal(frozen[1].zipSha256, null);
  assert.equal(frozen[1].acquisitionError, 'acquisition unavailable');
  assert.equal(frozen[2].zipSha256, digest(bytes));
});

test('archive freezing refuses byte size and Git blob identity mismatches', async () => {
  const bytes = Buffer.from('inert'), selection = selectExpanded(syntheticTrees())[0];
  for (const record of [{ ...selection, zipBytes: 99, blobSha1: blobHash(bytes) },
    { ...selection, zipBytes: bytes.length, blobSha1: 'a'.repeat(40) }]) {
    const [frozen] = await freezeArchiveIdentities([record], { request: async () => bytes });
    assert.equal(frozen.zipSha256, null);
    assert.ok(frozen.acquisitionError);
  }
});

test('evaluation preserves frozen failures, per-case scan failures and exact cohort accounting', async () => {
  const input = structuredClone(manifest), calls = [], directories = [];
  input.cases[0].zipSha256 = null; input.cases[0].acquisitionError = 'frozen acquisition failed';
  const result = await evaluateRecords(input.cases, { evaluate: async (record, work) => {
    calls.push(record.sourcePath); directories.push(work);
    assert.equal(Object.isFrozen(record), true);
    await fs.writeFile(`${work}/inert.txt`, 'fixture only');
    if (calls.length === 1) throw new Error('bounded scan failure');
    if (calls.length === 2) return { rawVerdict: 'safe', guardDecision: 'block', sourceComplete: false };
    return { rawVerdict: calls.length === 3 ? 'review' : 'block', guardDecision: 'block', sourceComplete: true };
  } });
  assert.equal(calls.length, 31);
  assert.ok(!calls.includes(input.cases[0].sourcePath));
  assert.deepEqual(result.cases.map(record => record.sourcePath), manifest.cases.map(record => record.sourcePath));
  assert.deepEqual(result.counts, { selected: 32, rawBlock: 28, rawUncertainty: 1, rawSafe: 1, errors: 2, frozenAcquisitionErrors: 1, completed: 30 });
  assert.equal(result.metrics.rawBlockRateAmongSelected, 28 / 32);
  assert.equal(result.metrics.rawBlockRateAmongCompleted, 28 / 30);
  assert.equal(result.byCategory.compromised_lib.counts.selected, 4);
  assert.equal(result.byCategory.malicious_intent.counts.selected, 28);
  assert.equal(result.sourceCoverage.incomplete, 1);
  assert.equal(result.cases[0].errorStage, 'freeze');
  assert.equal(result.cases[1].errorStage, 'acquisition-extraction-or-scan');
  for (const directory of directories) await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('frozen input is snapshotted and malformed raw verdicts cannot become detections', async () => {
  const input = structuredClone(manifest);
  let calls = 0;
  const result = await evaluateFrozen(input, { evaluate: async () => {
    calls++;
    input.cases[calls % 32].zipSha256 = 'b'.repeat(64);
    return calls === 1 ? { guardDecision: 'block' } : { rawVerdict: 'review', guardDecision: 'block' };
  } });
  assert.equal(result.counts.errors, 1);
  assert.equal(result.counts.rawUncertainty, 31);
  assert.equal(result.counts.rawBlock, 0);
  assert.deepEqual(result.cases.map(record => record.zipSha256), manifest.cases.map(record => record.zipSha256));
});

test('manifest mutations cannot widen bounds, alter original identities, omit cases or invent categories', () => {
  for (const change of [m => { m.bounds.zipBytes++; }, m => { m.cases.pop(); },
    m => { m.cases.reverse(); }, m => { m.cases[0].zipSha256 = 'a'.repeat(64); },
    m => { m.cases[10].rank = 'b'.repeat(64); }, m => { m.cases[0].sourcePath = '../escape.zip'; },
    m => { m.allocation.compromised_lib = 16; }, m => { m.cases[0].label = 'benign'; }]) {
    const changed = structuredClone(manifest); change(changed);
    assert.throws(() => validateManifest(changed));
  }
});

test('eligible-looking later rank replacements are rejected before any evaluation', async () => {
  const changed = structuredClone(manifest), record = changed.cases.at(-1);
  record.sourcePath = 'samples/npm/malicious_intent/replacement-0/1.0.0/2024-01-01-fixture.zip';
  record.packageName = 'replacement-0'; record.version = '1.0.0'; record.zipBytes = 100;
  record.rank = digest(record.sourcePath); record.blobSha1 = 'a'.repeat(40); record.zipSha256 = 'b'.repeat(64);
  let called = false;
  await assert.rejects(evaluateFrozen(changed, { evaluate: async () => { called = true; } }), /frozen cohort pin/);
  assert.equal(called, false);
});

test('oversized declared downloads reject as bounded acquisition errors without uncaught stream errors', async () => {
  const { execFile } = require('node:child_process'), { promisify } = require('node:util');
  const source = `const assert=require('node:assert/strict');const https=require('node:https');const {PassThrough}=require('node:stream');const {EventEmitter}=require('node:events');
https.get=(url,options,callback)=>{const req=new EventEmitter();req.destroy=error=>req.emit('error',error);process.nextTick(()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-length':'17'};res.on('close',()=>req.emit('close'));callback(res);});return req;};
const {download}=require('./scripts/validate-external-corpus');download('https://raw.githubusercontent.com/inert',16,1).then(()=>process.exitCode=2,error=>{assert.match(error.message,/size limit/);});`;
  const result = await promisify(execFile)(process.execPath, ['-e', source], { cwd: require('node:path').join(__dirname, '..'), timeout: 5000 });
  assert.equal(result.stderr, '');
});

test('identity and outcome summaries disclose correlated bytes without merging cases', () => {
  const records = [
    { packageName: 'one', version: '1', sourcePath: 'one', zipSha256: 'same', derivedTreeSha256: 'tree', rawVerdict: 'block' },
    { packageName: 'two', version: '1', sourcePath: 'two', zipSha256: 'same', derivedTreeSha256: 'tree', rawVerdict: 'review' },
    { packageName: 'two', version: '2', sourcePath: 'three', error: 'acquisition failed', errorStage: 'freeze' }
  ];
  const identities = identitySummary(records), summary = summarize(records);
  assert.equal(identities.distinctPackageNames, 2);
  assert.equal(identities.distinctPackageVersions, 3);
  assert.equal(identities.duplicateArchiveHashes.length, 1);
  assert.equal(identities.duplicateDerivedTreeHashes.length, 1);
  assert.equal(summary.counts.selected, 3);
  assert.equal(summary.counts.rawBlock, 1);
  assert.equal(summary.counts.rawUncertainty, 1);
  assert.equal(summary.counts.errors, 1);
  assert.throws(() => summarize([{}]), /Unaccounted/);
});

test('raw outcomes come from the assessment independently of configured verdict and guard blocks', () => {
  const observed = guardObservation({ assessment: { rawVerdict: 'block', policySha256: 'a'.repeat(64),
    checks: { source: 'completed', vulnerabilities: 'disabled' }, engine: { buildId: 'build' } },
    report: { verdict: 'safe', findings: [{ category: 'configured-category' }] }, decision: 'block', sourceCoverage: { complete: true } });
  assert.equal(observed.rawVerdict, 'block');
  assert.equal(observed.configuredVerdict, 'safe');
  assert.equal(observed.guardDecision, 'block');
  assert.equal(observed.policySha256, 'a'.repeat(64));
  assert.equal(observed.checks.vulnerabilities, 'disabled');
  assert.deepEqual(observed.configuredFindingCategories, ['configured-category']);
  assert.throws(() => guardObservation({ report: { verdict: 'block' }, decision: 'block' }), /Missing raw/);
  assert.equal(identitySummary([]).duplicateDerivedTreeHashes, null, 'unmeasured derived trees are not zero observed duplicates');
});
