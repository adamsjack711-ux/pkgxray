#!/usr/bin/env node
"use strict";

// Static-only third-party evaluation. No package install/import/canary path is
// used. Real payloads exist only under a fresh private directory and are reaped.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { guardExtension } = require('../src/quarantine');
const { BUILD_ID } = require('../src/artifact');
const execFileAsync = promisify(execFile);

const REPOSITORY = 'DataDog/malicious-software-packages-dataset';
const COMMIT = 'df32a361b27b78c5de4cdb4b4c549b666accaa40';
const CATEGORIES = ['compromised_lib', 'malicious_intent'];
// Exact, immutable versions from established packages provide a small benign
// contrast set. The hashes bind the registry bytes; the labels remain project
// assumptions, not independent certification or a prevalence sample.
const BENIGN_CONTROLS = Object.freeze([
  { label: 'benign', packageName: 'escape-string-regexp', version: '5.0.0', zipBytes: null,
    sourceUrl: 'https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-5.0.0.tgz',
    artifactSha256: 'c8b662afe8aa2b852ecc27d766e584a502f8351fbbd890611f2509bf083d28e6' },
  { label: 'benign', packageName: 'is-number', version: '7.0.0', zipBytes: null,
    sourceUrl: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
    artifactSha256: '7b75c1057198cf97696909a9bee176c9c5e9bcb5b03bf3ecef2f484defadd51e' },
  { label: 'benign', packageName: 'picocolors', version: '1.1.1', zipBytes: null,
    sourceUrl: 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz',
    artifactSha256: 'd3aedb2807967b7eb37fd11b03b7e3701e725af79c650d0812ff7213f8f882d9' },
  { label: 'benign', packageName: 'yocto-queue', version: '1.2.1', zipBytes: null,
    sourceUrl: 'https://registry.npmjs.org/yocto-queue/-/yocto-queue-1.2.1.tgz',
    artifactSha256: '2b3bd9bfcd6ca5e17556846221a11e15b43c81f76cb6bce3059405fed9753055' }
]);
const MAX_ZIP_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const SELECTION = 'Malicious: at pinned revision, one lexicographically first pre-2025 discovery ZIP per distinct npm package, ZIP <= 4 MiB; rank paths by SHA256 and take four per category. Benign: four declared exact-version registry controls with pinned SHA256. No replacement on errors and no selection by scanner verdict.';

function digest(bytes, algorithm = 'sha256', encoding = 'hex') {
  return crypto.createHash(algorithm).update(bytes).digest(encoding);
}

function selectCases(tree, category, count = 4) {
  if (tree.truncated) throw new Error('Refusing selection from a truncated tree');
  if (!CATEGORIES.includes(category)) throw new Error('Unsupported corpus category');
  const first = new Map();
  for (const entry of [...tree.tree].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (entry.type !== 'blob' || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_ZIP_BYTES) continue;
    const match = /^([@A-Za-z0-9_.-]+)\/(\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)\/(202[0-4]-\d{2}-\d{2}-[^/]+\.zip)$/.exec(entry.path);
    if (!match || first.has(match[1])) continue;
    const packageName = match[1].startsWith('@') ? match[1].replace(/^(@[^@]+)@/, '$1/') : match[1];
    const sourcePath = `samples/npm/${category}/${entry.path}`;
    first.set(match[1], { category, sourcePath, packageName, version: match[2], zipBytes: entry.size, rank: digest(sourcePath) });
  }
  return [...first.values()].sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, count);
}

function downloadOnce(url, maxBytes) {
  const target = new URL(url);
  if (!['api.github.com', 'raw.githubusercontent.com', 'registry.npmjs.org'].includes(target.hostname) || target.protocol !== 'https:') throw new Error('Unexpected corpus origin');
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    const req = https.get(target, { headers: { 'user-agent': 'pkgxray-static-corpus-validation', accept: 'application/vnd.github+json' } }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        const error = new Error(`Corpus request HTTP ${res.statusCode}`);
        error.statusCode = res.statusCode;
        reject(error);
        return;
      }
      if (Number(res.headers['content-length']) > maxBytes) { res.destroy(new Error('Corpus download size limit exceeded')); return; }
      res.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) { res.destroy(new Error('Corpus download size limit exceeded')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('aborted', () => reject(new Error('Corpus download interrupted')));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('Corpus request deadline exceeded')), 20000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

function isTransientDownloadError(error) {
  return error.statusCode === 429 || error.statusCode >= 500 ||
    /deadline|interrupted|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(error.message);
}

async function download(url, maxBytes, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await downloadOnce(url, maxBytes);
    } catch (error) {
      lastError = error;
      if (!isTransientDownloadError(error) || attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

function summarizeCases(cases) {
  const empty = () => ({ safe: 0, review: 0, block: 0, errors: 0 });
  const byLabel = { malicious: empty(), benign: empty() };
  for (const record of cases) {
    const bucket = byLabel[record.label];
    if (!bucket) throw new Error(`Unexpected corpus label: ${record.label}`);
    if (Object.hasOwn(bucket, record.verdict)) bucket[record.verdict]++;
    else bucket.errors++;
  }
  const scanned = bucket => bucket.safe + bucket.review + bucket.block;
  const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
  return {
    byLabel,
    metrics: {
      maliciousHoldRate: ratio(byLabel.malicious.review + byLabel.malicious.block, scanned(byLabel.malicious)),
      maliciousBlockRate: ratio(byLabel.malicious.block, scanned(byLabel.malicious)),
      benignFalseBlockRate: ratio(byLabel.benign.block, scanned(byLabel.benign)),
      benignReviewRate: ratio(byLabel.benign.review, scanned(byLabel.benign))
    }
  };
}

async function unwrap(zipPath, tarballPath) {
  const result = await execFileAsync('python3', [path.join(__dirname, 'read-external-archive.py'), zipPath, tarballPath], {
    timeout: 15000, maxBuffer: 4096, env: { PATH: process.env.PATH || '/usr/bin:/bin', PYTHONNOUSERSITE: '1' }
  });
  return JSON.parse(result.stdout);
}

function safeExtractorAvailable() {
  if (process.platform === 'win32') return false;
  const probe = spawnSync('python3', ['-c', 'import os,zipfile;assert os.name == "posix" and hasattr(os,"O_NOFOLLOW")'], {
    timeout: 3000, stdio: 'ignore', env: { PATH: process.env.PATH || '/usr/bin:/bin', PYTHONNOUSERSITE: '1' }
  });
  return !probe.error && probe.status === 0;
}

async function evaluateCorpus(options = {}) {
  if (!safeExtractorAvailable()) throw new Error('Static corpus evaluation requires POSIX Python 3 with O_NOFOLLOW; refusing unsafe extraction fallback');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pkgxray-external-static-'));
  await fsp.chmod(root, 0o700);
  const startedAt = new Date().toISOString();
  try {
    const inventory = JSON.parse((await download(`https://api.github.com/repos/${REPOSITORY}/contents/samples/npm?ref=${COMMIT}`, MAX_METADATA_BYTES)).toString('utf8'));
    const selected = [];
    for (const category of CATEGORIES) {
      const entry = inventory.find(item => item.name === category && item.type === 'dir');
      if (!entry || !/^[a-f0-9]{40}$/.test(entry.sha)) throw new Error('Missing category at pinned commit');
      const tree = JSON.parse((await download(`https://api.github.com/repos/${REPOSITORY}/git/trees/${entry.sha}?recursive=1`, MAX_METADATA_BYTES)).toString('utf8'));
      selected.push(...selectCases(tree, category));
    }
    // Selection is finalized before downloading or scanning any payload.
    options.onSelection?.(selected);
    const cases = [];
    for (let index = 0; index < selected.length; index++) {
      const selection = selected[index];
      const work = path.join(root, String(index)); await fsp.mkdir(work, { mode: 0o700 });
      const record = { label: 'malicious', ...selection }; delete record.rank;
      try {
        const encodedPath = selection.sourcePath.split('/').map(encodeURIComponent).join('/');
        const zip = await download(`https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}/${encodedPath}`, MAX_ZIP_BYTES);
        if (zip.length !== selection.zipBytes) throw new Error('Corpus archive size differs from pinned tree');
        record.zipSha256 = digest(zip);
        const zipPath = path.join(work, 'sample.zip'); await fsp.writeFile(zipPath, zip, { mode: 0o600 });
        const archivePath = path.join(work, 'artifact');
        const unwrapped = await unwrap(zipPath, archivePath);
        record.scanInput = unwrapped.mode;
        let artifact;
        if (unwrapped.mode === 'original-tarball') {
          const tarball = await fsp.readFile(archivePath);
          record.artifactSha256 = digest(tarball);
          artifact = { archivePath, integrity: `sha512-${digest(tarball, 'sha512', 'base64')}` };
        } else {
          record.derivedTreeSha256 = unwrapped.treeSha256;
          record.derivedTreeFiles = unwrapped.files;
        }
        const result = await guardExtension(artifact ? `npm:${selection.packageName}@${selection.version}` : `file:${archivePath}`, {
          ...(artifact ? { artifact } : {}),
          quarantineRoot: path.join(work, 'quarantine'), keepStaging: false,
          provenance: false, githubMetadata: false, githubDiff: false,
          vulnerabilityCheck: false, sourceScan: true, scanDependencies: false,
          maxFiles: 1000, maxTotalScanBytes: 32 * 1024 * 1024
        });
        record.verdict = result.report.verdict;
        record.decision = result.decision;
        record.sourceComplete = result.sourceCoverage.complete;
        record.findingCategories = [...new Set(result.report.findings.map(finding => finding.category))].sort();
      } catch (error) {
        record.error = typeof error.code === 'string' ? error.code : error.stderr?.trim() || error.message.slice(0, 240);
      } finally {
        await fsp.rm(work, { recursive: true, force: true });
      }
      cases.push(record);
      options.onCase?.(record);
    }
    for (let index = 0; index < BENIGN_CONTROLS.length; index++) {
      const control = BENIGN_CONTROLS[index];
      const work = path.join(root, `benign-${index}`); await fsp.mkdir(work, { mode: 0o700 });
      const record = { ...control };
      delete record.zipBytes;
      try {
        const tarball = await download(control.sourceUrl, MAX_ZIP_BYTES);
        const actualSha256 = digest(tarball);
        if (actualSha256 !== control.artifactSha256) throw new Error('Benign control SHA256 differs from pinned bytes');
        record.artifactBytes = tarball.length;
        const archivePath = path.join(work, 'artifact.tgz');
        await fsp.writeFile(archivePath, tarball, { mode: 0o600 });
        const result = await guardExtension(`npm:${control.packageName}@${control.version}`, {
          artifact: { archivePath, integrity: `sha512-${digest(tarball, 'sha512', 'base64')}` },
          quarantineRoot: path.join(work, 'quarantine'), keepStaging: false,
          provenance: false, githubMetadata: false, githubDiff: false,
          vulnerabilityCheck: false, sourceScan: true, scanDependencies: false,
          maxFiles: 1000, maxTotalScanBytes: 32 * 1024 * 1024
        });
        record.verdict = result.report.verdict;
        record.decision = result.decision;
        record.sourceComplete = result.sourceCoverage.complete;
        record.findingCategories = [...new Set(result.report.findings.map(finding => finding.category))].sort();
      } catch (error) {
        record.error = typeof error.code === 'string' ? error.code : error.stderr?.trim() || error.message.slice(0, 240);
      } finally {
        await fsp.rm(work, { recursive: true, force: true });
      }
      cases.push(record);
      options.onCase?.(record);
    }
    const summary = summarizeCases(cases);
    return { schemaVersion: 2, repository: REPOSITORY, commit: COMMIT,
      scannerVersion: require('../package.json').version, scannerBuildId: BUILD_ID,
      bounds: { zipBytes: MAX_ZIP_BYTES, zipExpandedBytes: 16 * 1024 * 1024, zipEntries: 512, tarballExpandedBytes: 64 * 1024 * 1024 },
      sourceUrl: `https://github.com/${REPOSITORY}/tree/${COMMIT}`, startedAt,
      selection: SELECTION, mode: 'static-only; source heuristics with network enrichment disabled; extracted package trees where original TGZ is absent',
      limitations: 'Small third-party labeled malicious sample plus four project-selected benign controls; neither is independently certified accuracy or representative prevalence data. Dataset selection bias remains and no package code is executed. Original ZIP hashes bind corpus archives; derived tree hashes do not establish original npm tarball identity. REVIEW is a hold requiring human review, not a confirmed malware detection. Acquisition/scan errors are retained and not replaced.',
      counts: summary.byLabel, metrics: summary.metrics, cases, payloadsRetained: false };
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

if (require.main === module) evaluateCorpus({
  onSelection: cases => process.stderr.write(`Selected ${cases.length} cases before scanning.\n`),
  onCase: record => process.stderr.write(`${record.packageName}@${record.version}: ${record.verdict || 'ERROR'}\n`)
}).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.counts.malicious.safe || result.counts.malicious.errors || result.counts.benign.block || result.counts.benign.errors) process.exitCode = 1;
}).catch(error => { process.stderr.write(`Static corpus validation failed: ${error.message}\n`); process.exitCode = 1; });

module.exports = { selectCases, unwrap, evaluateCorpus, safeExtractorAvailable, summarizeCases,
  isTransientDownloadError, BENIGN_CONTROLS, COMMIT, SELECTION };
