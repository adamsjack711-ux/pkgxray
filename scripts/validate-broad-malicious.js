#!/usr/bin/env node
'use strict';

// Acquisition and static evaluation are separate commands. Freezing never
// extracts archives or calls the scanner; a failed selected case is retained.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { selectCases, download, digest, unwrap, safeExtractorAvailable,
  REPOSITORY, COMMIT, CATEGORIES, MAX_ZIP_BYTES, MAX_METADATA_BYTES } = require('./validate-external-corpus');
const ORIGINAL = require('../benchmark/external-four-controls-validation-2026-11-11.json').cases.filter(c => c.label === 'malicious');
const ALLOCATION = Object.freeze({ compromised_lib: 4, malicious_intent: 28 });
const REQUESTED_ALLOCATION = Object.freeze({ compromised_lib: 16, malicious_intent: 16 });
const BOUNDS = Object.freeze({ zipBytes: MAX_ZIP_BYTES, selectedExpandedBytes: 16 * 1024 * 1024,
  zipEntries: 512, tarballExpandedBytes: 64 * 1024 * 1024 });
const DEFAULT_MANIFEST = path.join(__dirname, '../benchmark/broad-malicious-manifest.json');
// Frozen before any payload scan. A new cohort requires a reviewed new pin;
// syntactic eligibility/rank sorting alone does not establish the first ranks.
const FROZEN_CASES_SHA256 = '37079b3f50d0b545bbae5b9084c22b64ea271f42f14e0da59eb9008dc888f33d';
const SELECTION = 'At pinned DataDog revision, retain the lexicographically first eligible pre-2025 discovery ZIP per distinct npm package (ZIP <=4 MiB), then rank source paths by SHA256. The requested 16+16 allocation is impossible: complete compromised_lib inventory has only four eligible packages. Before any scans, allocate four compromised_lib plus the first 28 malicious_intent cases, transferring the 12-case shortfall to the next malicious_intent ranks. The first four per category are the original eight. No replacement on acquisition, extraction, or scan errors.';
const errorText = error => String(error?.code || error?.message || 'Evaluation failed').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240);
const archiveUrl = record => `https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}/${record.sourcePath.split('/').map(encodeURIComponent).join('/')}`;
const blobHash = bytes => digest(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1');

function identitySummary(records) {
  const duplicates = key => {
    const groups = new Map();
    for (const record of records) if (record[key]) {
      if (!groups.has(record[key])) groups.set(record[key], []);
      groups.get(record[key]).push(record.sourcePath);
    }
    return [...groups].filter(([, paths]) => paths.length > 1).map(([hash, sourcePaths]) => ({ hash, sourcePaths }));
  };
  return { distinctPackageNames: new Set(records.map(record => record.packageName)).size,
    distinctPackageVersions: new Set(records.map(record => `${record.packageName}@${record.version}`)).size,
    archiveHashesObserved: records.filter(record => record.zipSha256).length,
    derivedTreeHashesObserved: records.filter(record => record.derivedTreeSha256).length,
    duplicateArchiveHashes: duplicates('zipSha256'),
    duplicateDerivedTreeHashes: records.some(record => record.derivedTreeSha256) ? duplicates('derivedTreeSha256') : null,
    originalArchiveComparisons: ORIGINAL.map(original => {
      const record = records.find(item => item.sourcePath === original.sourcePath);
      return { sourcePath: original.sourcePath, expectedSha256: original.zipSha256,
        status: !record?.zipSha256 ? 'not-acquired' : record.zipSha256 === original.zipSha256 ? 'unchanged' : 'mismatch' };
    }),
    familyOrCampaignIndependence: 'Unknown. Distinct package identities or archive hashes do not establish independent malware families or campaigns.' };
}

function selectExpanded(trees) {
  return CATEGORIES.flatMap(category => {
    const tree = trees[category];
    const eligible = selectCases(tree, category, Number.MAX_SAFE_INTEGER);
    if (category === 'compromised_lib' && eligible.length !== 4) throw new Error('Compromised category shortfall evidence changed');
    const selected = eligible.slice(0, ALLOCATION[category]);
    if (selected.length !== ALLOCATION[category]) throw new Error(`Insufficient eligible cases: ${category}`);
    return selected.map((record, index) => {
      const relative = record.sourcePath.slice(`samples/npm/${category}/`.length);
      const entry = tree.tree.find(item => item.path === relative);
      if (!/^[a-f0-9]{40}$/.test(entry?.sha)) throw new Error('Missing selected Git blob identity');
      return { label: 'malicious', ...record, categoryRank: index + 1, originalCohort: index < 4, blobSha1: entry.sha };
    });
  });
}

function assertOriginalPrefix(selected) {
  const original = selected.filter(record => record.originalCohort);
  if (original.length !== 8 || ORIGINAL.length !== 8 || original.some((record, index) => record.sourcePath !== ORIGINAL[index].sourcePath)) {
    throw new Error('Expanded selection does not preserve the original eight-case prefix');
  }
}

async function freezeArchiveIdentities(selected, { request = download, onCase } = {}) {
  const records = [];
  for (const selection of selected) {
    const record = { ...selection, zipSha256: null };
    try {
      const bytes = await request(archiveUrl(selection), MAX_ZIP_BYTES);
      if (!Buffer.isBuffer(bytes) || bytes.length !== selection.zipBytes || bytes.length > MAX_ZIP_BYTES) throw new Error('Archive size differs from pinned tree');
      if (blobHash(bytes) !== selection.blobSha1) throw new Error('Archive differs from pinned Git blob');
      record.zipSha256 = digest(bytes);
    } catch (error) { record.acquisitionError = errorText(error); }
    records.push(record);
    onCase?.(record);
  }
  return records;
}

async function freezeSelection({ request = download, onSelection, onCase } = {}) {
  const inventory = JSON.parse((await request(`https://api.github.com/repos/${REPOSITORY}/contents/samples/npm?ref=${COMMIT}`, MAX_METADATA_BYTES)).toString('utf8'));
  const trees = {}, categoryTrees = {};
  for (const category of CATEGORIES) {
    const entry = inventory.find(item => item.name === category && item.type === 'dir');
    if (!/^[a-f0-9]{40}$/.test(entry?.sha)) throw new Error('Missing pinned category tree');
    trees[category] = JSON.parse((await request(`https://api.github.com/repos/${REPOSITORY}/git/trees/${entry.sha}?recursive=1`, MAX_METADATA_BYTES)).toString('utf8'));
    if (trees[category].sha !== entry.sha) throw new Error('Category tree identity mismatch');
    categoryTrees[category] = entry.sha;
  }
  const selected = selectExpanded(trees);
  assertOriginalPrefix(selected);
  onSelection?.(selected.map(record => ({ ...record })));
  const manifest = { schemaVersion: 1, kind: 'frozen-external-malicious-cohort', repository: REPOSITORY,
    commit: COMMIT, frozenAt: new Date().toISOString(), allocation: { ...ALLOCATION }, requestedAllocation: { ...REQUESTED_ALLOCATION },
    availableEligibleCases: Object.fromEntries(CATEGORIES.map(category => [category, selectCases(trees[category], category, Number.MAX_SAFE_INTEGER).length])), selection: SELECTION,
    labelProvenance: 'DataDog dataset category labels; not independent verification or a representative prevalence sample.',
    bounds: { ...BOUNDS }, categoryTrees, cases: await freezeArchiveIdentities(selected, { request, onCase }),
    payloadsRetained: false, scansPerformed: 0 };
  manifest.identities = identitySummary(manifest.cases);
  validateManifestShape(manifest);
  return manifest;
}

function validateManifestShape(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'frozen-external-malicious-cohort' ||
      manifest.repository !== REPOSITORY || manifest.commit !== COMMIT ||
      CATEGORIES.some(category => manifest.allocation?.[category] !== ALLOCATION[category] || manifest.requestedAllocation?.[category] !== REQUESTED_ALLOCATION[category]) ||
      manifest.availableEligibleCases?.compromised_lib !== 4 || !Number.isSafeInteger(manifest.availableEligibleCases?.malicious_intent) || manifest.availableEligibleCases.malicious_intent < 28 ||
      manifest.scansPerformed !== 0 || manifest.payloadsRetained !== false ||
      !Array.isArray(manifest.cases) || manifest.cases.length !== 32 ||
      Object.entries(BOUNDS).some(([key, value]) => manifest.bounds?.[key] !== value)) throw new Error('Invalid frozen cohort contract');
  const seen = new Set(), packages = new Set();
  for (const [index, record] of manifest.cases.entries()) {
    const category = index < 4 ? 'compromised_lib' : 'malicious_intent', rank = index < 4 ? index + 1 : index - 3;
    const prefix = `samples/npm/${category}/`;
    if (!/^[a-f0-9]{40}$/.test(manifest.categoryTrees?.[category] || '') || record.label !== 'malicious' ||
        record.category !== category || record.categoryRank !== rank || record.originalCohort !== (rank <= 4) ||
        typeof record.sourcePath !== 'string' || !record.sourcePath.startsWith(prefix) || seen.has(record.sourcePath) || packages.has(`${category}:${record.packageName}`) ||
        !/^[a-f0-9]{40}$/.test(record.blobSha1 || '') || record.rank !== digest(record.sourcePath)) throw new Error('Invalid frozen case identity/order');
    const eligible = selectCases({ tree: [{ type: 'blob', size: record.zipBytes, path: record.sourcePath.slice(prefix.length) }] }, category, 1)[0];
    if (!eligible || eligible.packageName !== record.packageName || eligible.version !== record.version ||
        (rank > 1 && manifest.cases[index - 1].rank.localeCompare(record.rank) >= 0)) throw new Error('Invalid frozen case eligibility/rank');
    const failed = typeof record.acquisitionError === 'string' && record.acquisitionError.length > 0;
    if (Object.hasOwn(record, 'acquisitionError') && (!failed || record.acquisitionError.length > 240)) throw new Error('Invalid frozen acquisition error');
    if (failed ? record.zipSha256 !== null : !/^[a-f0-9]{64}$/.test(record.zipSha256 || '')) throw new Error('Unfrozen archive identity');
    const original = ORIGINAL.find(item => item.sourcePath === record.sourcePath);
    if (original && !failed && record.zipSha256 !== original.zipSha256) throw new Error('Original archive identity changed');
    seen.add(record.sourcePath);
    packages.add(`${category}:${record.packageName}`);
  }
  assertOriginalPrefix(manifest.cases);
  return manifest;
}

function validateManifest(manifest) {
  validateManifestShape(manifest);
  if (digest(Buffer.from(JSON.stringify(manifest.cases))) !== FROZEN_CASES_SHA256) throw new Error('Case identities differ from the frozen cohort pin');
  return manifest;
}

function guardObservation(result) {
  const assessment = result.assessment;
  if (!['block', 'review', 'safe'].includes(assessment?.rawVerdict) || !/^[a-f0-9]{64}$/.test(assessment?.policySha256 || '')) throw new Error('Missing raw assessment or policy identity');
  return { rawVerdict: assessment.rawVerdict, configuredVerdict: result.report?.verdict, guardDecision: result.decision,
    policySha256: assessment.policySha256, checks: assessment.checks, assessmentBuildId: assessment.engine?.buildId,
    sourceComplete: result.sourceCoverage?.complete === true,
    configuredFindingCategories: [...new Set((result.report?.findings || []).map(f => f.category))].sort() };
}

async function scanCase(selection, work) {
  if (!safeExtractorAvailable()) throw new Error('POSIX Python3 O_NOFOLLOW extractor is required');
  const bytes = await download(archiveUrl(selection), MAX_ZIP_BYTES);
  if (bytes.length !== selection.zipBytes || digest(bytes) !== selection.zipSha256 || blobHash(bytes) !== selection.blobSha1) throw new Error('Archive identity differs from frozen manifest');
  const zipPath = path.join(work, 'sample.zip'), archivePath = path.join(work, 'artifact');
  await fs.writeFile(zipPath, bytes, { mode: 0o600, flag: 'wx' });
  const unwrapped = await unwrap(zipPath, archivePath);
  let artifact;
  const record = { scanInput: unwrapped.mode, archiveSelection: unwrapped.archiveSelection };
  if (unwrapped.mode === 'original-tarball') {
    const tarball = await fs.readFile(archivePath);
    record.artifactSha256 = digest(tarball);
    artifact = { archivePath, integrity: `sha512-${digest(tarball, 'sha512', 'base64')}` };
  } else {
    record.derivedTreeSha256 = unwrapped.treeSha256; record.derivedTreeFiles = unwrapped.files;
  }
  const { guardExtension } = require('../src/quarantine');
  const result = await guardExtension(artifact ? `npm:${selection.packageName}@${selection.version}` : `file:${archivePath}`, {
    ...(artifact ? { artifact } : {}), quarantineRoot: path.join(work, 'quarantine'), keepStaging: false,
    provenance: false, githubMetadata: false, githubDiff: false, vulnerabilityCheck: false,
    sourceScan: true, scanDependencies: false, maxFiles: 1000, maxTotalScanBytes: 32 * 1024 * 1024
  });
  const observed = guardObservation(result);
  if (observed.assessmentBuildId !== require('../src/artifact').BUILD_ID) throw new Error('Assessment scanner build mismatch');
  if (!['completed', 'partial'].includes(observed.checks?.source) || observed.checks?.vulnerabilities !== 'disabled' ||
      observed.checks?.directDependencies !== 'not-requested') throw new Error('Static measurement check contract changed');
  return { ...record, ...observed };
}

function summarize(cases) {
  const counts = { selected: cases.length, rawBlock: 0, rawUncertainty: 0, rawSafe: 0, errors: 0, frozenAcquisitionErrors: 0 };
  const sourceCoverage = { complete: 0, incomplete: 0, unknown: 0 };
  for (const record of cases) {
    if (record.error) { counts.errors++; if (record.errorStage === 'freeze') counts.frozenAcquisitionErrors++; }
    else if (record.rawVerdict === 'block') counts.rawBlock++;
    else if (record.rawVerdict === 'review') counts.rawUncertainty++;
    else if (record.rawVerdict === 'safe') counts.rawSafe++;
    else throw new Error('Unaccounted corpus outcome');
    if (!record.error) sourceCoverage[record.sourceComplete === true ? 'complete' : record.sourceComplete === false ? 'incomplete' : 'unknown']++;
  }
  counts.completed = counts.rawBlock + counts.rawUncertainty + counts.rawSafe;
  return { counts, sourceCoverage, metrics: { rawBlockRateAmongSelected: counts.selected ? counts.rawBlock / counts.selected : null,
    rawBlockRateAmongCompleted: counts.completed ? counts.rawBlock / counts.completed : null,
    rawUncertaintyRateAmongCompleted: counts.completed ? counts.rawUncertainty / counts.completed : null } };
}

// Case processing is separately injectable for inert error-accounting tests.
// The CLI and evaluateFrozen always validate the exact cohort before this step.
async function evaluateRecords(selections, { evaluate, onCase } = {}) {
  if (typeof evaluate !== 'function') throw new Error('Case processor requires an explicit evaluator');
  selections = structuredClone(selections);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkgxray-broad-static-'));
  await fs.chmod(root, 0o700);
  const cases = [];
  try {
    for (const [index, selection] of selections.entries()) {
      const record = { ...selection }, work = path.join(root, String(index));
      if (selection.acquisitionError) { record.error = selection.acquisitionError; record.errorStage = 'freeze'; }
      else {
        await fs.mkdir(work, { mode: 0o700 });
        try {
          const outcome = await evaluate(Object.freeze({ ...selection }), work);
          if (!['block', 'review', 'safe'].includes(outcome?.rawVerdict)) throw new Error('Missing or invalid raw analyzer verdict');
          for (const key of ['rawVerdict', 'configuredVerdict', 'guardDecision', 'policySha256', 'checks', 'assessmentBuildId', 'sourceComplete', 'configuredFindingCategories', 'scanInput', 'archiveSelection', 'artifactSha256', 'derivedTreeSha256', 'derivedTreeFiles']) {
            if (Object.hasOwn(outcome, key)) record[key] = outcome[key];
          }
        } catch (error) { record.error = errorText(error); record.errorStage = 'acquisition-extraction-or-scan'; }
        finally { await fs.rm(work, { recursive: true, force: true }); }
      }
      cases.push(record); onCase?.({ ...record });
    }
    const policies = [...new Set(cases.map(record => record.policySha256).filter(Boolean))].sort();
    return { ...summarize(cases), byCategory: Object.fromEntries(CATEGORIES.map(category => [category, summarize(cases.filter(record => record.category === category))])),
      observedPolicySha256: policies, policyConsistency: policies.length === 0 ? 'not-observed' : policies.length === 1 ? 'consistent' : 'changed',
      identities: identitySummary(cases), cases, payloadsRetained: false };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function evaluateFrozen(manifest, options = {}) {
  manifest = structuredClone(manifest);
  validateManifest(manifest);
  const { BUILD_ID } = require('../src/artifact');
  const result = await evaluateRecords(manifest.cases, { evaluate: scanCase, ...options });
  return { schemaVersion: 1, frozenCasesSha256: FROZEN_CASES_SHA256,
    parsedManifestSha256: digest(Buffer.from(JSON.stringify(manifest))),
    parsedManifestEncoding: 'UTF-8 JSON.stringify(parsed manifest), without formatting or trailing newline', repository: REPOSITORY,
    commit: COMMIT, scannerBuildId: BUILD_ID, scannerVersion: require('../package.json').version,
    measuredAt: new Date().toISOString(), mode: 'static-only; no package execution or installation', bounds: { ...BOUNDS },
    limitations: 'External dataset labels, selected historical cohort, not independently verified accuracy or representative prevalence. Family/campaign independence is unknown; correlated variants remain selected. Raw block, uncertainty, safe and errors are separate. CVE and network enrichment are disabled: guard blocks are not malicious detections or install approvals. Only selected ZIP content is decompressed; derived tree hashes do not identify original npm tarballs. Frozen acquisition failures remain errors and are never replaced.',
    allocation: { ...ALLOCATION }, requestedAllocation: { ...REQUESTED_ALLOCATION }, availableEligibleCases: manifest.availableEligibleCases,
    ...result };
}

async function main(args) {
  if (args.length < 1 || args.length > 2 || !['--freeze', '--scan'].includes(args[0])) throw new Error('Usage: node scripts/validate-broad-malicious.js --freeze|--scan [manifest.json]');
  const filename = args[1] || DEFAULT_MANIFEST;
  if (args[0] === '--freeze') {
    const manifest = await freezeSelection({ onSelection: cases => process.stderr.write(`Frozen selection of ${cases.length} cases before archive acquisition; no scans.\n`),
      onCase: record => process.stderr.write(`${record.packageName}@${record.version}: ${record.acquisitionError ? 'ACQUISITION ERROR' : 'HASHED'}\n`) });
    await fs.writeFile(filename, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Wrote frozen manifest: ${filename}\n`);
  } else {
    const bytes = await fs.readFile(filename);
    if (bytes.length > MAX_METADATA_BYTES) throw new Error('Manifest size limit exceeded');
    const result = await evaluateFrozen(JSON.parse(bytes), { onCase: record => process.stderr.write(`${record.packageName}@${record.version}: ${record.rawVerdict || 'ERROR'}\n`) });
    result.manifestSha256 = digest(bytes);
    result.manifestEncoding = 'Exact UTF-8 manifest file bytes, including formatting and trailing newline';
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.counts.errors || result.counts.rawSafe) process.exitCode = 1;
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1; });
module.exports = { selectExpanded, freezeArchiveIdentities, freezeSelection, validateManifest, evaluateFrozen, evaluateRecords, summarize, identitySummary, guardObservation, blobHash, BOUNDS, ALLOCATION };
