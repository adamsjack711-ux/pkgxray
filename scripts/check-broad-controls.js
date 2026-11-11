'use strict';
// Observational follow-up only: this harness never changes scanner policy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BENIGN_CONTROLS } = require('./validate-external-corpus');
const { runPinnedControls } = require('./live-control-runner');
const MANIFEST_PATH = path.join(__dirname, '../benchmark/broad-live-cohort-2026-11-11.json');
const { COHORT_ID, LIMITS, SELECTED, integritySpec, registryUrl } = require('./acquire-broad-live-cohort');
const STRATA = Object.freeze({ utilities: 12, 'larger-libraries': 8, 'framework-tooling': 6, 'network-native': 6 });
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateManifest(input) {
  const fail = reason => { throw new Error(`Invalid broad cohort manifest: ${reason}`); };
  if (!object(input) || input.schemaVersion !== 1 || input.cohortId !== COHORT_ID || input.selectedCount !== 32 ||
      !Array.isArray(input.cases) || input.cases.length !== 32) fail('expected the fixed 32-case cohort');
  if (typeof input.selection !== 'string' || !input.selection.trim() ||
      !Number.isFinite(Date.parse(input.selectionFrozenAt)) || !Number.isFinite(Date.parse(input.acquiredAt))) fail('missing selection or acquisition metadata');
  if (!object(input.limits) || Object.entries(LIMITS).some(([key, value]) => input.limits[key] !== value)) fail('unexpected acquisition limits');
  const names = new Set(), identities = new Set(), strata = new Map(), originals = new Set();
  for (const [index, control] of input.cases.entries()) {
    const bad = reason => fail(`case ${index + 1}: ${reason}`);
    if (!object(control) || typeof control.packageName !== 'string' || control.packageName.length > 214 || !PACKAGE_NAME.test(control.packageName)) bad('invalid package name');
    const selected = SELECTED[index];
    if (control.packageName !== selected.packageName || control.stratum !== selected.stratum || control.selection !== selected.selection) bad('fixed cohort membership changed');
    if (names.has(control.packageName)) bad('duplicate package identity');
    names.add(control.packageName);
    if (!Object.hasOwn(STRATA, control.stratum)) bad('unknown stratum');
    strata.set(control.stratum, (strata.get(control.stratum) || 0) + 1);
    if (!['original-control', 'latest-at-acquisition'].includes(control.selection)) bad('unknown selection');
    if (!object(control.acquisition) || !['verified', 'error'].includes(control.acquisition.status)) bad('missing acquisition outcome');
    for (const key of ['metadataAttempts', 'tarballAttempts']) {
      if (!Number.isSafeInteger(control.acquisition[key]) || control.acquisition[key] < 0 || control.acquisition[key] > 2) bad('invalid acquisition attempt count');
    }
    const verified = control.acquisition.status === 'verified';
    if (verified || control.version !== null) {
      if (typeof control.version !== 'string' || control.version.length > 128 || !EXACT_VERSION.test(control.version)) bad('version is not exact');
      if (control.reference !== `${control.packageName}@${control.version}`) bad('reference does not match identity');
    } else if (control.reference !== null) bad('reference without resolved version');
    const identity = `${control.packageName}@${control.version}`;
    if (identities.has(identity)) bad('duplicate version identity');
    identities.add(identity);
    if ((verified || control.expectedSha256 !== null) && (typeof control.expectedSha256 !== 'string' || !HASH.test(control.expectedSha256))) bad('invalid artifact SHA256');
    if (verified) {
      try { registryUrl(control.sourceUrl); integritySpec(control.distIntegrity); } catch { bad('invalid artifact URL or integrity'); }
      if (control.acquisition.metadataAttempts < 1 || control.acquisition.tarballAttempts < 1) bad('verified acquisition lacks attempts');
      if (!Number.isSafeInteger(control.compressedBytes) || control.compressedBytes < 1 || control.compressedBytes > input.limits.compressedBytes || control.acquisition.error) bad('invalid verified acquisition');
    } else if (!object(control.acquisition.error) || typeof control.acquisition.error.code !== 'string' || !control.acquisition.error.code ||
               typeof control.acquisition.error.message !== 'string') bad('missing acquisition error');
    const original = BENIGN_CONTROLS.find(candidate => candidate.packageName === control.packageName);
    if (control.selection === 'original-control') {
      if (!original || control.version !== original.version || (control.expectedSha256 !== null && control.expectedSha256 !== original.artifactSha256)) bad('original control pin changed');
      originals.add(control.packageName);
    } else if (original) bad('original control was replaced');
  }
  for (const [stratum, count] of Object.entries(STRATA)) if (strata.get(stratum) !== count) fail('stratum size mismatch');
  if (originals.size !== BENIGN_CONTROLS.length) fail('missing original controls');
  // Snapshot before starting asynchronous work: callers cannot swap identities
  // halfway through a measurement by mutating an injected manifest.
  return structuredClone(input);
}
function summarize(cases) {
  const byStratum = Object.fromEntries(Object.keys(STRATA).map(key => [key, { allow: 0, block: 0, error: 0 }]));
  const groups = { blockReasonCodes: new Map(), blockCategories: new Map(), mandatoryHoldReasons: new Map(), checkStates: new Map(), errors: new Map() };
  const count = (group, key) => group.set(key, (group.get(key) || 0) + 1);
  for (const entry of cases) {
    byStratum[entry.stratum][entry.status]++;
    if (entry.status === 'block') {
      for (const reason of entry.reasonCodes || []) count(groups.blockReasonCodes, reason);
      for (const category of entry.categories || []) count(groups.blockCategories, category);
    }
    for (const reason of entry.mandatoryHoldReasons || []) count(groups.mandatoryHoldReasons, reason);
    for (const [name, state] of Object.entries(entry.checks || {})) count(groups.checkStates, `${name}:${typeof state === 'string' ? state : 'invalid'}`);
    if (entry.error) count(groups.errors, entry.error);
  }
  return { byStratum, ...Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, Object.fromEntries([...group].sort(([a], [b]) => a.localeCompare(b)))])),
    interpretation: 'Reason groups overlap. Blocks, including vulnerability findings and missing required checks, are observations and are not classified as false positives.' };
}
async function runBroadControls({ createClient, manifest } = {}) {
  const bytes = manifest === undefined ? fs.readFileSync(MANIFEST_PATH) : Buffer.from(JSON.stringify(manifest));
  const frozen = validateManifest(manifest === undefined ? JSON.parse(bytes.toString('utf8')) : manifest);
  const result = await runPinnedControls(frozen.cases, { createClient });
  return { ...result, cohortId: frozen.cohortId,
    manifestSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    manifestEncoding: manifest === undefined ? 'exact frozen file bytes' : 'JSON serialization of injected test manifest',
    selectionFrozenAt: frozen.selectionFrozenAt, acquiredAt: frozen.acquiredAt, selection: frozen.selection,
    selectedCount: frozen.selectedCount, acquisitionLimits: frozen.limits,
    aggregates: summarize(result.cases),
    limitations: 'Selected established-package candidates, not independently certified benign software or a random prevalence sample. No false-positive rate, production accuracy, malicious recall, or latency benchmark is inferred. Current vulnerabilities and incomplete checks may legitimately block. Direct dependency and provenance scans are not requested by this harness; actual check states are recorded. assessment.rawVerdict is recorded exactly as MCP exposes it (internal uncertainty may be presented as inconclusive).' };
}
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    console.error('Usage: node scripts/check-broad-controls.js --live (fixed manifest; real npm/OSV checks; exits nonzero for invalid measurement, not for a valid block).');
    process.exitCode = 1;
  } else {
    runBroadControls().then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.measurementValid) process.exitCode = 1;
    }).catch(() => { console.error('Broad control measurement failed: manifest validation or harness startup did not complete.'); process.exitCode = 1; });
  }
}
module.exports = { runBroadControls, validateManifest, COHORT_ID, STRATA };
