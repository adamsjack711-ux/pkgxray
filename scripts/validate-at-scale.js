#!/usr/bin/env node
'use strict';
// Measure heuristic block candidates, completion, and review burden across a
// popular-package corpus. Heuristic blocks require adjudication before anyone
// can label them false positives. Incomplete scans count as errors, not reviews.
//
// Usage:
//   node scripts/validate-at-scale.js [--ecosystem <npm|pypi>] [--list <file>]
//        [--limit N] [--concurrency N] [--timeout-ms N] [--out-dir <dir>]
//        [--cohort <name>] [--emit-stats <file> --run-id <id>]
//
// --ecosystem picks the guard scheme (npm:/pypi:) and the default corpus list
// (pinned validation/calibration-2026-07-19/top1000-targets.txt for npm,
// validation/top-pypi-1000.txt for PyPI). Ecosystems have separate directories.
//
// Outputs (default --out-dir validation/results/):
//   results.jsonl      one JSON object per package (decision, grade, findings)
//   report.md          human-readable summary with the candidate block list
//   summary.json       aggregate completion, gate, and review burden metrics
//   review-queue.json  local per-package review groups and available citations
// Exit code: 0 if validation gates pass, 1 if they fail, 2 for invalid input/errors.
//
// Cohorts: `--cohort mcp` labels the run and defaults the out-dir to
// validation/results/mcp/, so MCP figures are NEVER merged into the npm
// numbers. `--emit-stats` additionally writes a stats-site artifact in the
// exact shape of website/stats/data/<runId>.json — catch-rate figures come
// from `node benchmark/run.js --json --cohort <name>` (the committed corpus),
// heuristic block candidate figures from this scan. Nothing is published automatically:
// review the artifact by hand before copying it into website/stats/data/.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const AUDIT = path.join(ROOT, 'bin', 'audit.js');

// Guard schemes keyed by ecosystem, and the default corpus list for each.
const ECOSYSTEMS = {
  npm: { scheme: 'npm', defaultList: path.join(ROOT, 'validation', 'calibration-2026-07-19', 'top1000-targets.txt') },
  pypi: { scheme: 'pypi', defaultList: path.join(ROOT, 'validation', 'top-pypi-1000.txt') },
};

function parseArgs(argv) {
  const a = {
    ecosystem: 'npm',
    list: null, // resolved from --ecosystem after the loop unless overridden
    limit: Infinity,
    concurrency: 6,
    timeoutMs: 30000,
    outDir: null,
    cohort: null,
    emitStats: null,
    runId: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] !== '--help' && argv[i] !== '-h' &&
        (v === undefined || v.startsWith('--'))) {
      throw new Error(`missing value for ${argv[i]}`);
    }
    switch (argv[i]) {
      case '--ecosystem': a.ecosystem = String(v).toLowerCase(); i++; break;
      case '--list': a.list = path.resolve(v); i++; break;
      case '--limit': a.limit = Number(v); i++; break;
      case '--concurrency': a.concurrency = Number(v); i++; break;
      case '--timeout-ms': a.timeoutMs = Number(v); i++; break;
      case '--out-dir': a.outDir = path.resolve(v); i++; break;
      case '--cohort': a.cohort = v; i++; break;
      case '--emit-stats': a.emitStats = path.resolve(v); i++; break;
      case '--run-id': a.runId = v; i++; break;
      case '--help': case '-h':
        console.log('node scripts/validate-at-scale.js [--ecosystem npm|pypi] [--list f] [--limit N] [--concurrency N] [--timeout-ms N] [--out-dir d] [--cohort name] [--emit-stats f --run-id id]');
        process.exit(0);
      default:
        throw new Error(`unknown arg: ${argv[i]}`);
    }
  }
  const eco = ECOSYSTEMS[a.ecosystem];
  if (!eco) {
    throw new Error(`unknown --ecosystem "${a.ecosystem}" (expected: ${Object.keys(ECOSYSTEMS).join(', ')})`);
  }
  for (const [flag, value] of [['--concurrency', a.concurrency], ['--timeout-ms', a.timeoutMs],
    ...(argv.includes('--limit') ? [['--limit', a.limit]] : [])]) {
    if (!Number.isSafeInteger(value) || value < 1 || (flag === '--timeout-ms' && value > 2147483647)) {
      throw new Error(`${flag} must be a positive integer${flag === '--timeout-ms' ? ' <= 2147483647' : ''}`);
    }
  }
  a.scheme = eco.scheme;
  // Default the corpus list to the ecosystem's canonical top-list unless the
  // caller passed an explicit --list.
  if (!a.list) a.list = eco.defaultList;
  // A cohort run keeps its results in its own directory so it can never be
  // conflated with the default (npm top-1000) numbers.
  if (!a.outDir) {
    a.outDir = a.cohort || a.ecosystem !== 'npm'
      ? path.join(ROOT, 'validation', 'results', a.cohort || a.ecosystem)
      : path.join(ROOT, 'validation', 'results');
  }
  if (a.emitStats && !a.runId) {
    throw new Error('--emit-stats requires --run-id (e.g. --run-id 2026-07-25-mcp)');
  }
  return a;
}

function readList(file, limit) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const pkgs = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    pkgs.push(l);
    if (pkgs.length >= limit) break;
  }
  return pkgs;
}

// Run one guard, resolve to a normalized result record.
function guardOne(pkg, timeoutMs, scheme, startChild = spawn) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = startChild(process.execPath, [AUDIT, 'guard', `${scheme}:${pkg}`, '--format', 'json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', timedOut = false;
    const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const ms = Date.now() - started;
      let rec = { package: pkg, decision: 'error', grade: null, score: null, findings: [], ms, exit: code, error: null };
      if (timedOut || signal || ![0, 2, 3].includes(code)) {
        rec.error = timedOut ? `timeout after ${timeoutMs}ms` : `guard terminated (${signal || `exit ${code}`})`;
        resolve(rec);
        return;
      }
      try {
        const j = JSON.parse(out);
        const r = j.report || {};
        // A verdict that carries scanError is guard failing CLOSED (fetch/OSV
        // outage -> review), not an analyzed package. Counting it as a real
        // review would silently inflate the calibration denominator — record
        // it as an error, exactly as the published methodology promises.
        if (j.scanError || j.vulnerabilityPrecheck?.error) {
          rec.decision = 'error';
          rec.error = String(j.scanError || j.vulnerabilityPrecheck.error).slice(0, 200);
        } else {
          const decision = j.decision || r.verdict;
          if (['safe', 'allow', 'review', 'block'].includes(decision) && Array.isArray(r.findings)) {
            rec.decision = decision;
            rec.resolved = j.resolved ? {
              packageName: j.resolved.packageName ?? null,
              version: j.resolved.version ?? null,
              sha256: j.resolved.sha256 ?? null,
            } : null;
          } else {
            rec.error = 'invalid guard result';
          }
        }
        rec.grade = r.grade ?? null;
        rec.score = r.score ?? null;
        rec.findings = (r.findings || []).map(normalizeFinding);
      } catch {
        rec.decision = 'error';
        rec.error = (err.trim().split('\n').pop() || `no-json (exit ${code})`).slice(0, 200);
      }
      resolve(rec);
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({ package: pkg, decision: 'error', grade: null, score: null, findings: [], ms: Date.now() - started, exit: null, error: String(e.message).slice(0, 200) });
    });
  });
}

// Bounded-concurrency pool with a live progress line.
async function runPool(pkgs, concurrency, timeoutMs, scheme, onResult) {
  let idx = 0, done = 0;
  const total = pkgs.length;
  async function worker() {
    while (idx < total) {
      const my = idx++;
      const rec = await guardOne(pkgs[my], timeoutMs, scheme);
      done++;
      onResult(rec);
      if (done % 10 === 0 || done === total) {
        process.stderr.write(`\r  scanned ${done}/${total} …`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  process.stderr.write('\n');
}

function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : 'not measured'; }
function rate(n, d) { return d ? Math.round(n / d * 10000) / 10000 : null; }

// A block is a TRUE positive if it carries a known-vulnerability finding: the
// package has a published CVE (OSV), and pkgxray must never allow that away.
// A block WITHOUT a vuln finding is heuristic-driven — the only kind that can be
// a false positive on a benign package, and the number that must be 0 for 1.0.
function isVulnBlock(r) {
  return r.findings.some((f) => f.category === 'known-vulnerability');
}

// Packages whose heuristic block is CORRECT/defensible (they genuinely perform
// the flagged high-risk operation), audited and committed in
// defensible-blocks.json. Excluded from the false-block gate the same way
// known-CVE blocks are. The file is keyed by ecosystem ({ npm: {...},
// pypi: {...} }) so a defensible block in one registry never whitelists a
// same-named package in another — load only THIS run's ecosystem.
function loadDefensibleBlocks(ecosystem) {
  try {
    const p = path.join(ROOT, 'validation', 'defensible-blocks.json');
    const byEco = JSON.parse(fs.readFileSync(p, 'utf8')).packages || {};
    return new Set(Object.keys(byEco[ecosystem] || {}));
  } catch {
    return new Set();
  }
}
function isDefensibleBlock(r, defensible) {
  // The documented entries identify packages, while calibration inputs can be
  // version-pinned. Prefer the resolved identity; otherwise strip only a trailing
  // @version separator, preserving the leading @ on scoped npm names. This is
  // report classification only and never changes a scanner verdict.
  if (r.resolved && typeof r.resolved.packageName === 'string' && r.resolved.packageName) {
    return defensible.has(r.resolved.packageName);
  }
  const input = r.package;
  if (typeof input !== 'string') return false;
  const versionAt = input.lastIndexOf('@');
  const name = versionAt > 0 ? input.slice(0, versionAt) : input;
  return defensible.has(name);
}

// Guard decisions use allow; direct audit verdicts use safe. Accept both.
function clearBucket(d) { return d === 'safe' || d === 'allow'; }

// Retain the scanner's citations locally without copying arbitrary report fields
// into aggregate artifacts. Duplicate citations can be collapsed, but distinct
// files/snippets in one category must remain separately reviewable.
function normalizeFinding(f) {
  const normalized = { severity: f.severity, category: f.category };
  for (const key of ['file', 'snippet', 'rationale']) {
    if (typeof f[key] === 'string') normalized[key] = f[key];
  }
  if (Number.isSafeInteger(f.line) && f.line > 0) normalized.line = f.line;
  return normalized;
}

const REVIEW_STEPS = {
  'flow-analysis-gap': 'Identify the unsupported or incomplete analysis in the cited report; obtain supported static coverage or complete a manual source review before resolving it.',
  'install-hook': 'Inspect each lifecycle script and referenced source; confirm its purpose and required file, process, and network access for this package version.',
  'lonely-maintainer': 'Check publisher identity, release history, and available provenance; record whether the maintainer concentration is acceptable for this dependency.',
  'npm-vs-github-divergence': 'Compare cited published files with the matching source release and documented build outputs; explain each difference.',
  'code-execution': 'Trace cited process or dynamic-code calls and their inputs; confirm the commands and when they can run are expected.',
};
const SEVERITY_RANK = { unknown: 0, info: 1, low: 2, medium: 3, high: 4, critical: 5 };
function highestSeverity(findings) {
  return findings.reduce((highest, f) => (SEVERITY_RANK[f.severity] || 0) > SEVERITY_RANK[highest] ? f.severity : highest, 'unknown');
}
function buildReviewQueue(a, results, collection = a.collection || {}) {
  const groups = new Map();
  for (const r of results.filter((result) => result.decision === 'review')) {
    const findings = [...new Map(r.findings.map(normalizeFinding).map((f) => [JSON.stringify(f), f])).values()]
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    const signals = findings.filter((f) => f.severity !== 'info');
    const categories = [...new Set(signals.map((f) => f.category || 'uncategorized'))].sort();
    const key = JSON.stringify(categories);
    if (!groups.has(key)) groups.set(key, { categories, packages: [] });
    const cited = signals.filter((f) => f.file && f.snippet).length;
    groups.get(key).packages.push({
      package: r.package,
      resolved: r.resolved || null,
      decision: 'review',
      highestSeverity: highestSeverity(signals),
      evidenceStatus: signals.length && cited === signals.length ? 'complete' : cited ? 'partial' : 'unavailable',
      findings,
    });
  }
  const grouped = [...groups.values()].map((group) => ({
    ...group,
    highestSeverity: highestSeverity(group.packages.map((r) => ({ severity: r.highestSeverity }))),
    nextSteps: group.categories.length ? group.categories.map((category) => ({
      category,
      action: REVIEW_STEPS[category] || 'Inspect each cited finding and confirm the behavior is necessary and expected for this package version.',
    })) : [{ category: null, action: 'Inspect the full guard report and policy to identify why review was required; do not infer approval from missing findings.' }],
    packages: group.packages.sort((x, y) => SEVERITY_RANK[y.highestSeverity] - SEVERITY_RANK[x.highestSeverity] || x.package.localeCompare(y.package)),
  })).sort((x, y) => SEVERITY_RANK[y.highestSeverity] - SEVERITY_RANK[x.highestSeverity] || y.packages.length - x.packages.length || JSON.stringify(x.categories).localeCompare(JSON.stringify(y.categories)));
  return {
    schemaVersion: 1,
    ecosystem: a.ecosystem,
    cohort: a.cohort || a.ecosystem,
    collection: {
      collectedOn: collection.collectedOn || (collection.startedAt ? collection.startedAt.slice(0, 10) : null),
      startedAt: collection.startedAt || null,
      sourceRevision: collection.sourceRevision || null,
      sourceTreeDirty: typeof collection.sourceTreeDirty === 'boolean' ? collection.sourceTreeDirty : null,
      resultsSha256: collection.resultsSha256 || null,
      runnerSha256: collection.runnerSha256 || null,
    },
    instructions: 'Groups organize static review; they do not approve packages or change verdicts. Review every package version and record its decision separately. Missing citations require a fresh static scan of that exact version before source review.',
    groups: grouped,
  };
}
function summarizeReviewQueue(queue) {
  const total = queue.groups.reduce((n, g) => n + g.packages.length, 0);
  const evidenceCoverage = { complete: 0, partial: 0, unavailable: 0 };
  const groups = queue.groups.map((group) => {
    for (const r of group.packages) evidenceCoverage[r.evidenceStatus]++;
    return { categories: group.categories, packages: group.packages.length,
      of: total, rate: rate(group.packages.length, total),
      highestSeverity: group.highestSeverity, nextSteps: group.nextSteps };
  });
  return { collection: queue.collection, grouping: 'exact-non-info-category-set', groupsCount: groups.length,
    packages: total, evidenceCoverage, groups, resolutionTimeMinutes: null };
}

// Centralize completion and accuracy gates so CLI reports and published stats
// cannot disagree about whether the run supplied usable evidence.
function summarizeValidation(a, pkgs, results, defensible = loadDefensibleBlocks(a.ecosystem)) {
  const successful = results.filter((r) => clearBucket(r.decision) || ['review', 'block'].includes(r.decision));
  const errors = results.length - successful.length;
  const blocks = successful.filter((r) => r.decision === 'block');
  const candidates = blocks.filter((r) => !isVulnBlock(r) && !isDefensibleBlock(r, defensible));
  const reviews = successful.filter((r) => r.decision === 'review');
  const reasons = new Map();
  for (const r of reviews) {
    for (const category of new Set(r.findings.filter((f) => f.severity !== 'info' && f.category).map((f) => f.category))) {
      reasons.set(category, (reasons.get(category) || 0) + 1);
    }
  }
  const failures = [];
  if (!pkgs.length) failures.push('empty corpus');
  if (results.length !== pkgs.length) failures.push('not all requested scans completed');
  if (!successful.length) failures.push('at least 1 successful scan is required');
  if (results.length && errors / results.length > 0.1) failures.push('scan error rate exceeds 10%');
  if (candidates.length) failures.push('heuristic block candidates require investigation');
  return {
    schemaVersion: 1,
    ecosystem: a.ecosystem,
    cohort: a.cohort || a.ecosystem,
    completion: {
      expected: pkgs.length,
      attempted: results.length,
      succeeded: successful.length,
      errors,
      completionRate: rate(results.length, pkgs.length),
      errorRate: rate(errors, results.length),
      minimumSuccessfulScans: 1,
      maximumErrorRate: 0.1,
    },
    decisions: {
      safe: successful.filter((r) => clearBucket(r.decision)).length,
      review: reviews.length,
      block: blocks.length,
    },
    blockBreakdown: {
      knownVulnerability: blocks.filter(isVulnBlock).length,
      defensible: blocks.filter((r) => !isVulnBlock(r) && isDefensibleBlock(r, defensible)).length,
      heuristicCandidates: candidates.length,
    },
    heuristicBlockCandidates: {
      count: candidates.length, of: successful.length, rate: rate(candidates.length, successful.length),
      classification: 'unadjudicated-heuristic-block-candidates',
    },
    adjudicatedFalsePositives: null,
    reviewWorkflow: summarizeReviewQueue(buildReviewQueue(a, results)),
    reviewBurden: {
      count: reviews.length,
      of: successful.length,
      rate: rate(reviews.length, successful.length),
      reasons: [...reasons].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([category, packages]) => ({ category, packages })),
      resolutionTimeMinutes: null,
    },
    gate: { passed: failures.length === 0, failures },
  };
}

// Keep legacy headline keys for the stats site; added classification makes clear
// these candidates have not been adjudicated as false positives.
function buildStatsArtifact(a, results, heuristicBlocks, expectedCount = results.length, runSync = spawnSync) {
  const metrics = summarizeValidation(a, { length: expectedCount }, results);
  if (!metrics.gate.passed) {
    throw new Error(`refusing to emit stats: ${metrics.gate.failures.join('; ')}`);
  }
  const benchArgs = [path.join(ROOT, 'benchmark', 'run.js'), '--json'];
  benchArgs.push('--cohort', a.cohort || a.ecosystem);
  const bench = runSync(process.execPath, benchArgs, { cwd: ROOT, encoding: 'utf8' });
  if (bench.error || bench.signal || bench.status !== 0) {
    throw new Error(`benchmark run failed (exit ${bench.status}): ${(bench.error?.message || bench.stderr || bench.signal || '').trim().slice(0, 200)}`);
  }
  let summary;
  try {
    summary = JSON.parse(bench.stdout).summary;
    for (const key of ['malicious', 'maliciousBlocking', 'misses']) {
      if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) throw new Error('invalid count');
    }
    if (summary.maliciousBlocking > summary.malicious || summary.misses > summary.malicious) throw new Error('invalid denominator');
  } catch {
    throw new Error('benchmark returned invalid summary');
  }

  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch {}
  let commit = 'unknown';
  const rev = runSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (rev.status === 0) commit = rev.stdout.trim();
  const scanned = metrics.completion.succeeded;
  const crOf = summary.malicious;
  const crBlocked = summary.maliciousBlocking;
  return {
    schemaVersion: 1,
    runId: a.runId,
    runDate: new Date().toISOString().slice(0, 10),
    cohort: a.cohort || a.ecosystem,
    pkgxray: {
      version, build: 'validation', commit, node: process.version,
      command: `pkgxray guard ${a.scheme}:<name>@<version> --format json`,
    },
    headline: {
      packagesAttempted: metrics.completion.attempted,
      packagesScanned: scanned,
      scanErrors: metrics.completion.errors,
      topThousandFalseBlocks: metrics.heuristicBlockCandidates,
      knownMalwareCatchRate: {
        blocked: crBlocked, of: crOf, rate: rate(crBlocked, crOf), passedAsSafe: summary.misses,
      },
    },
    completion: metrics.completion,
    blockBreakdown: metrics.blockBreakdown,
    reviewBurden: metrics.reviewBurden,
    reviewWorkflow: metrics.reviewWorkflow,
    adjudicatedFalsePositives: null,
    methodologyUrl: `/stats/${a.runId}-methodology`,
    reproInputs: (() => {
      const rel = path.relative(ROOT, a.list).replace(/\\/g, '/');
      return rel.startsWith('..') ? a.list : `https://github.com/adamsjack711-ux/pkgxray/blob/main/${rel}`;
    })(),
    corrections: {
      contact: 'https://github.com/adamsjack711-ux/pkgxray/issues (label: calibration)',
      policy: 'Versioned runs are immutable. A corrected number is published as a new dated run; corrections are listed on the page, never silently edited.',
      log: [],
    },
    notes: `Separate ${a.cohort || a.ecosystem} cohort: ${scanned} successful static scans. ` +
      (crOf ? `Catch rate: ${crBlocked} of ${crOf} malicious fixtures blocked. ` : 'Catch rate not measured: no malicious fixtures in this cohort. ') +
      'Heuristic blocks are candidates for investigation, not adjudicated false positives. Review burden excludes scan errors; resolution time is not measured. Review before publishing.',
  };
}

function buildReport(a, pkgs, results, wallMs) {
  const defensible = loadDefensibleBlocks(a.ecosystem);
  const metrics = summarizeValidation(a, pkgs, results, defensible);
  const by = { safe: [], review: [], block: [], error: [] };
  for (const r of results) {
    const bucket = clearBucket(r.decision) ? 'safe' : ['review', 'block'].includes(r.decision) ? r.decision : 'error';
    by[bucket].push(r);
  }
  const allBlocks = by.block || [];
  const vulnBlocks = allBlocks.filter(isVulnBlock);
  const defensibleBlocks = allBlocks.filter((r) => !isVulnBlock(r) && isDefensibleBlock(r, defensible));
  const heuristicBlocks = allBlocks.filter((r) => !isVulnBlock(r) && !isDefensibleBlock(r, defensible));
  const blocks = heuristicBlocks; // the false-positive candidates
  const reviews = by.review || [];
  const scanned = results.length;
  const resolved = scanned - (by.error ? by.error.length : 0);

  const topReasons = metrics.reviewBurden.reasons.map((r) => [r.category, r.packages]);

  const L = [];
  L.push(a.cohort
    ? `# pkgxray at-scale validation — "${a.cohort}" cohort (reported separately, never merged into the npm numbers)`
    : `# pkgxray at-scale validation — ${pkgs.length} selected ${a.ecosystem} packages`);
  L.push('');
  L.push(`Corpus: \`${path.relative(ROOT, a.list)}\` · ${pkgs.length} packages · concurrency ${a.concurrency} · ${(wallMs / 1000).toFixed(0)}s wall.`);
  L.push('');
  L.push('The gate requires every requested scan to complete, at least one successful scan,');
  L.push('an error rate of at most 10%, and zero unadjudicated heuristic block candidates.');
  L.push('Known-vulnerability and documented defensible blocks are reported separately.');
  L.push('Candidates require investigation; they are not adjudicated false positives.');
  L.push('');
  L.push('## Headline');
  L.push('');
  L.push(`| Decision | Count | % of successful scans |`);
  L.push(`|---|---:|---:|`);
  L.push(`| safe/allow | ${(by.safe || []).length} | ${pct((by.safe || []).length, resolved)} |`);
  L.push(`| review | ${reviews.length} | ${pct(reviews.length, resolved)} |`);
  L.push(`| block (known-vuln, correct) | ${vulnBlocks.length} | ${pct(vulnBlocks.length, resolved)} |`);
  L.push(`| block (defensible, real capability) | ${defensibleBlocks.length} | ${pct(defensibleBlocks.length, resolved)} |`);
  L.push(`| block (heuristic) | ${heuristicBlocks.length} | ${pct(heuristicBlocks.length, resolved)} |`);
  L.push(`| error/unresolved | ${(by.error || []).length} | excluded |`);
  L.push('');
  L.push(`- **Validation gate: ${metrics.gate.passed ? 'PASS' : 'FAIL'}**${metrics.gate.failures.length ? ' — ' + metrics.gate.failures.join('; ') : ''}`);
  L.push(`- Heuristic block candidates (unadjudicated): ${blocks.length}`);
  L.push(`- Review burden: ${reviews.length}/${resolved} successful scans (${pct(reviews.length, resolved)}); resolution time not measured.`);
  L.push(`- Correct blocks (known CVE): ${vulnBlocks.length}`);
  L.push(`- Defensible blocks (documented real capability, see validation/defensible-blocks.json): ${defensibleBlocks.length}${defensibleBlocks.length ? ' — ' + defensibleBlocks.map((r) => r.package).join(', ') : ''}`);
  L.push(`- Scanned: ${scanned} · resolved: ${resolved} · unresolved/error: ${scanned - resolved}`);
  L.push('');
  if (blocks.length) {
    L.push('## ❌ Heuristic blocks (candidate false positives — investigate each)');
    L.push('');
    L.push('| Package | Grade | Blocking findings |');
    L.push('|---|---|---|');
    for (const r of blocks) {
      const fs_ = r.findings.filter((f) => f.severity === 'high' || f.severity === 'critical').map((f) => f.category).join(', ') || r.findings.map((f) => f.category).join(', ');
      L.push(`| \`${r.package}\` | ${r.grade || '?'} | ${fs_} |`);
    }
    L.push('');
  }
  if (vulnBlocks.length) {
    L.push('## Correct blocks — known published vulnerability (not false positives)');
    L.push('');
    L.push('These carry an OSV/known-vulnerability finding. Blocking them is the intended behavior.');
    L.push('');
    L.push('| Package | Grade |');
    L.push('|---|---|');
    for (const r of vulnBlocks) L.push(`| \`${r.package}\` | ${r.grade || '?'} |`);
    L.push('');
  }
  L.push('## Why packages land in `review` (top finding categories)');
  L.push('');
  if (topReasons.length) {
    L.push('| Finding category | # of review packages |');
    L.push('|---|---:|');
    for (const [cat, n] of topReasons.slice(0, 15)) L.push(`| ${cat} | ${n} |`);
  } else {
    L.push('_No non-info findings among reviewed packages._');
  }
  L.push('');
  L.push('## Review groups');
  L.push('');
  L.push('Each reviewed package appears in one group of matching non-info categories. Groups organize work; they do not approve packages or reduce the review count.');
  L.push('The local `review-queue.json` includes each package version, available citations, and static review steps. Category-specific steps apply to every package in the group.');
  L.push('');
  const workflow = metrics.reviewWorkflow;
  L.push(`Evidence coverage: ${workflow.evidenceCoverage.complete} complete, ${workflow.evidenceCoverage.partial} partial, ${workflow.evidenceCoverage.unavailable} unavailable. Missing citations require a fresh static scan of the exact package version.`);
  L.push('');
  if (workflow.groups.length) {
    L.push('| Categories | Packages | Highest finding severity |');
    L.push('|---|---:|---|');
    for (const group of workflow.groups) L.push(`| ${group.categories.join(', ') || '(no non-info category)'} | ${group.packages} | ${group.highestSeverity} |`);
  } else {
    L.push('_No packages require review._');
  }
  L.push('');
  L.push('Review resolution time and time saved are not measured.');
  L.push('');
  L.push('## Errors (unresolved / timed out)');
  L.push('');
  L.push(`${(by.error || []).length} package(s) failed to resolve — including resolution, timeout, or vulnerability-check failures. These are honest gaps, not blocks. Full list in \`results.jsonl\` (decision: error).`);
  L.push('');
  return L.join('\n');
}

async function main(argv = process.argv, executePool = runPool) {
  const a = parseArgs(argv);
  const pkgs = readList(a.list, a.limit);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  a.collection = {
    startedAt: new Date().toISOString(),
    sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
    sourceTreeDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
    runnerSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  };
  fs.mkdirSync(a.outDir, { recursive: true });
  const jsonlPath = path.join(a.outDir, 'results.jsonl');
  const reportPath = path.join(a.outDir, 'report.md');
  const stream = fs.createWriteStream(jsonlPath);

  console.error(`validating ${pkgs.length} ${a.ecosystem} packages (concurrency ${a.concurrency}, timeout ${a.timeoutMs}ms) …`);
  const results = [];
  const t0 = Date.now();
  await executePool(pkgs, a.concurrency, a.timeoutMs, a.scheme, (rec) => {
    results.push(rec);
    stream.write(JSON.stringify(rec) + '\n');
  });
  await new Promise((res) => stream.end(res));
  const wallMs = Date.now() - t0;
  a.collection.resultsSha256 = createHash('sha256').update(fs.readFileSync(jsonlPath)).digest('hex');

  const metrics = summarizeValidation(a, pkgs, results);
  fs.writeFileSync(path.join(a.outDir, 'summary.json'), JSON.stringify(metrics, null, 2) + '\n');
  fs.writeFileSync(path.join(a.outDir, 'review-queue.json'), JSON.stringify(buildReviewQueue(a, results), null, 2) + '\n', { mode: 0o600 });
  const report = buildReport(a, pkgs, results, wallMs);
  fs.writeFileSync(reportPath, report + '\n');

  const defensible = loadDefensibleBlocks(a.ecosystem);
  const allBlocks = results.filter((r) => r.decision === 'block');
  const vulnBlocks = allBlocks.filter(isVulnBlock);
  const defensibleBlocks = allBlocks.filter((r) => !isVulnBlock(r) && isDefensibleBlock(r, defensible));
  const heuristicBlocks = allBlocks.filter((r) => !isVulnBlock(r) && !isDefensibleBlock(r, defensible));
  const counts = results.reduce((m, r) => ((m[r.decision] = (m[r.decision] || 0) + 1), m), {});
  console.error('');
  console.error('=== summary ===');
  console.error(counts);
  console.error(`heuristic block candidates (unadjudicated): ${heuristicBlocks.length}  (must be 0)`);
  console.error(`correct blocks (known CVE): ${vulnBlocks.length}`);
  console.error(`defensible blocks (documented): ${defensibleBlocks.length}${defensibleBlocks.length ? ' -> ' + defensibleBlocks.map((r) => r.package).join(', ') : ''}`);
  if (heuristicBlocks.length) console.error('  ->', heuristicBlocks.map((r) => r.package).join(', '));
  console.error(`report: ${path.relative(ROOT, reportPath)}`);
  console.error(`raw:    ${path.relative(ROOT, jsonlPath)}`);
  console.error(`validation gate: ${metrics.gate.passed ? 'PASS' : 'FAIL'}${metrics.gate.failures.length ? ' — ' + metrics.gate.failures.join('; ') : ''}`);
  if (a.emitStats && metrics.gate.passed) {
    const artifact = buildStatsArtifact(a, results, heuristicBlocks, pkgs.length);
    fs.mkdirSync(path.dirname(a.emitStats), { recursive: true });
    fs.writeFileSync(a.emitStats, JSON.stringify(artifact, null, 2) + '\n');
    console.error(`stats:  ${path.relative(ROOT, a.emitStats)}  (review by hand before copying into website/stats/data/)`);
  }
  return metrics.gate.passed ? 0 : 1;
}

module.exports = { buildReviewQueue, summarizeReviewQueue, guardOne, parseArgs, summarizeValidation, buildStatsArtifact, buildReport, main };
if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e.message); process.exitCode = 2; });
}
