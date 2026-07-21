#!/usr/bin/env node
'use strict';
// Run `pkgxray guard` across a large corpus of popular npm packages and prove
// the "0 false blocks" claim at scale. Zero-dependency, like the rest of pkgxray.
//
// The headline signal is FALSE BLOCKS: a `block` decision on a genuinely-benign
// popular package. That count must be 0. `review` is expected and by design
// (governance findings like lonely-maintainer, missing provenance) and is NOT a
// false positive. Packages that fail to resolve (unpublished/deprecated since
// the list was captured) are recorded as `error`, never counted as a block.
//
// Usage:
//   node scripts/validate-at-scale.js [--list <file>] [--limit N]
//        [--concurrency N] [--timeout-ms N] [--out-dir <dir>]
//        [--cohort <name>] [--emit-stats <file> --run-id <id>]
//
// Outputs (default --out-dir validation/results/):
//   results.jsonl      one JSON object per package (decision, grade, findings)
//   report.md          human-readable summary with the false-block list
// Exit code: 0 if false blocks == 0, else 1 (so CI can gate on it).
//
// Cohorts: `--cohort mcp` labels the run and defaults the out-dir to
// validation/results/mcp/, so MCP figures are NEVER merged into the npm
// numbers. `--emit-stats` additionally writes a stats-site artifact in the
// exact shape of website/stats/data/<runId>.json — catch-rate figures come
// from `node benchmark/run.js --json --cohort <name>` (the committed corpus),
// false-block figures from this scan. Nothing is published automatically:
// review the artifact by hand before copying it into website/stats/data/.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const AUDIT = path.join(ROOT, 'bin', 'audit.js');

function parseArgs(argv) {
  const a = {
    list: path.join(ROOT, 'validation', 'top1000.txt'),
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
    switch (argv[i]) {
      case '--list': a.list = path.resolve(v); i++; break;
      case '--limit': a.limit = Number(v); i++; break;
      case '--concurrency': a.concurrency = Number(v); i++; break;
      case '--timeout-ms': a.timeoutMs = Number(v); i++; break;
      case '--out-dir': a.outDir = path.resolve(v); i++; break;
      case '--cohort': a.cohort = v; i++; break;
      case '--emit-stats': a.emitStats = path.resolve(v); i++; break;
      case '--run-id': a.runId = v; i++; break;
      case '--help': case '-h':
        console.log('node scripts/validate-at-scale.js [--list f] [--limit N] [--concurrency N] [--timeout-ms N] [--out-dir d] [--cohort name] [--emit-stats f --run-id id]');
        process.exit(0);
      default:
        console.error('unknown arg:', argv[i]); process.exit(2);
    }
  }
  // A cohort run keeps its results in its own directory so it can never be
  // conflated with the default (npm top-1000) numbers.
  if (!a.outDir) {
    a.outDir = a.cohort
      ? path.join(ROOT, 'validation', 'results', a.cohort)
      : path.join(ROOT, 'validation', 'results');
  }
  if (a.emitStats && !a.runId) {
    console.error('--emit-stats requires --run-id (e.g. --run-id 2026-07-25-mcp)');
    process.exit(2);
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
function guardOne(pkg, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [AUDIT, 'guard', `npm:${pkg}`, '--format', 'json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => {
      clearTimeout(killer);
      const ms = Date.now() - started;
      let rec = { package: pkg, decision: 'error', grade: null, score: null, findings: [], ms, exit: code, error: null };
      try {
        const j = JSON.parse(out);
        const r = j.report || {};
        rec.decision = j.decision || r.verdict || 'error';
        rec.grade = r.grade ?? null;
        rec.score = r.score ?? null;
        rec.findings = (r.findings || []).map((f) => ({ severity: f.severity, category: f.category }));
      } catch {
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
async function runPool(pkgs, concurrency, timeoutMs, onResult) {
  let idx = 0, done = 0;
  const total = pkgs.length;
  async function worker() {
    while (idx < total) {
      const my = idx++;
      const rec = await guardOne(pkgs[my], timeoutMs);
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

function pct(n, d) { return d ? (100 * n / d).toFixed(1) : '0.0'; }

// A block is a TRUE positive if it carries a known-vulnerability finding: the
// package has a published CVE (OSV), and pkgxray must never allow that away.
// A block WITHOUT a vuln finding is heuristic-driven — the only kind that can be
// a false positive on a benign package, and the number that must be 0 for 1.0.
function isVulnBlock(r) {
  return r.findings.some((f) => f.category === 'known-vulnerability');
}

// Packages whose heuristic block is CORRECT/defensible (they genuinely perform
// the flagged high-risk operation), audited and committed in defensible-blocks.json.
// Excluded from the false-block gate the same way known-CVE blocks are.
const DEFENSIBLE_BLOCKS = (() => {
  try {
    const p = path.join(ROOT, 'validation', 'defensible-blocks.json');
    return new Set(Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).packages || {}));
  } catch {
    return new Set();
  }
})();
function isDefensibleBlock(r) {
  return DEFENSIBLE_BLOCKS.has(r.package);
}

// guard's JSON decision vocabulary is safe|review|block; older docs say allow.
function clearBucket(d) { return d === 'safe' || d === 'allow'; }

// Build a stats-site artifact in the exact shape of website/stats/data/*.json.
// False-block figures come from THIS scan; catch-rate figures come from the
// committed corpus via `benchmark/run.js --json [--cohort <name>]`. Numbers
// are only ever measured, never assumed: if the benchmark can't run, the
// artifact is not written.
function buildStatsArtifact(a, results, heuristicBlocks) {
  const benchArgs = [path.join(ROOT, 'benchmark', 'run.js'), '--json'];
  if (a.cohort) benchArgs.push('--cohort', a.cohort);
  const bench = spawnSync(process.execPath, benchArgs, { cwd: ROOT, encoding: 'utf8' });
  let summary;
  try {
    summary = JSON.parse(bench.stdout).summary;
  } catch {
    throw new Error(`benchmark run failed (exit ${bench.status}): ${(bench.stderr || '').trim().slice(0, 200)}`);
  }

  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch {}
  let commit = 'unknown';
  const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (rev.status === 0) commit = rev.stdout.trim();

  const runDate = new Date().toISOString().slice(0, 10);
  const scanned = results.length;
  const fbCount = heuristicBlocks.length;
  const crOf = summary.malicious;
  const crBlocked = summary.maliciousBlocking;
  const round4 = (n) => Math.round(n * 10000) / 10000;

  return {
    schemaVersion: 1,
    runId: a.runId,
    runDate,
    cohort: a.cohort || 'npm',
    pkgxray: {
      version,
      build: 'validation',
      commit,
      node: process.version,
      command: 'pkgxray guard npm:<name>@<version> --format json',
    },
    headline: {
      packagesScanned: scanned,
      // Same key the stats site reads for the false-block card; for a cohort
      // run, `of` is the cohort target-list size, not 1,000.
      topThousandFalseBlocks: {
        count: fbCount,
        of: scanned,
        rate: scanned ? round4(fbCount / scanned) : 0,
      },
      knownMalwareCatchRate: {
        blocked: crBlocked,
        of: crOf,
        rate: crOf ? round4(crBlocked / crOf) : 0,
        passedAsSafe: summary.misses,
      },
    },
    methodologyUrl: '/stats/methodology',
    reproInputs: (() => {
      const rel = path.relative(ROOT, a.list).replace(/\\/g, '/');
      return rel.startsWith('..') ? a.list : `https://github.com/adamsjack711-ux/pkgxray/blob/main/${rel}`;
    })(),
    corrections: {
      contact: 'https://github.com/adamsjack711-ux/pkgxray/issues (label: calibration)',
      policy: 'Versioned runs are immutable. A corrected number is published as a new dated run; corrections are listed on the page, never silently edited.',
      log: [],
    },
    notes: a.cohort === 'mcp'
      ? `Separate MCP-cohort calibration: ${scanned} npm-published MCP servers from the official MCP Registry, one static pass; never merged into the npm figures. Catch rate is measured against the ${crOf} MCP-tagged fixture(s) in the committed corpus — a small denominator reported as-is, not extrapolated. Review this artifact by hand before publishing.`
      : `Aggregate calibration of a one-time at-scale static scan. Catch rate is measured against the committed corpus (${crBlocked} of ${crOf} blocking). Review this artifact by hand before publishing.`,
  };
}

function buildReport(a, pkgs, results, wallMs) {
  const by = { safe: [], review: [], block: [], error: [] };
  for (const r of results) (by[r.decision] || (by[r.decision] = [])).push(r);
  const allBlocks = by.block || [];
  const vulnBlocks = allBlocks.filter(isVulnBlock);
  const defensibleBlocks = allBlocks.filter((r) => !isVulnBlock(r) && isDefensibleBlock(r));
  const heuristicBlocks = allBlocks.filter((r) => !isVulnBlock(r) && !isDefensibleBlock(r));
  const blocks = heuristicBlocks; // the false-positive candidates
  const reviews = by.review || [];
  const scanned = results.length;
  const resolved = scanned - (by.error ? by.error.length : 0);

  // review-reason breakdown (by highest-signal finding category)
  const reasonCounts = new Map();
  for (const r of reviews) {
    for (const f of r.findings) {
      if (f.severity === 'info') continue;
      reasonCounts.set(f.category, (reasonCounts.get(f.category) || 0) + 1);
    }
  }
  const topReasons = [...reasonCounts.entries()].sort((x, y) => y[1] - x[1]);

  const L = [];
  L.push(a.cohort
    ? `# pkgxray at-scale validation — "${a.cohort}" cohort (reported separately, never merged into the npm numbers)`
    : '# pkgxray at-scale validation — top-1000 npm packages');
  L.push('');
  L.push(`Corpus: \`${path.relative(ROOT, a.list)}\` · ${pkgs.length} packages · concurrency ${a.concurrency} · ${(wallMs / 1000).toFixed(0)}s wall.`);
  L.push('');
  L.push('The gate for 1.0 is **heuristic false blocks = 0**: a `block` on a');
  L.push('genuinely-benign popular package driven by static/behavioral heuristics.');
  L.push('A block that carries a **known-vulnerability** finding is a *true* positive —');
  L.push('the package has a published CVE and pkgxray must never allow it away — so');
  L.push('vuln blocks are reported separately, not counted against the target. `review`');
  L.push('is by design (governance/provenance signals). Packages that no longer resolve');
  L.push('are `error`, never `block`.');
  L.push('');
  L.push('## Headline');
  L.push('');
  L.push(`| Decision | Count | % of scanned |`);
  L.push(`|---|---:|---:|`);
  L.push(`| safe/allow | ${(by.safe || []).length} | ${pct((by.safe || []).length, scanned)}% |`);
  L.push(`| review | ${reviews.length} | ${pct(reviews.length, scanned)}% |`);
  L.push(`| block (known-vuln, correct) | ${vulnBlocks.length} | ${pct(vulnBlocks.length, scanned)}% |`);
  L.push(`| block (defensible, real capability) | ${defensibleBlocks.length} | ${pct(defensibleBlocks.length, scanned)}% |`);
  L.push(`| block (heuristic) | ${heuristicBlocks.length} | ${pct(heuristicBlocks.length, scanned)}% |`);
  L.push(`| error/unresolved | ${(by.error || []).length} | ${pct((by.error || []).length, scanned)}% |`);
  L.push('');
  L.push(`- **Heuristic false blocks: ${blocks.length}** ${blocks.length === 0 ? '✅ (target met)' : '❌ (must be 0 — investigate below)'}`);
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
  L.push('## Errors (unresolved / timed out)');
  L.push('');
  L.push(`${(by.error || []).length} package(s) failed to resolve — typically unpublished or deprecated since the 2019 corpus snapshot. These are honest gaps, not blocks. Full list in \`results.jsonl\` (decision: error).`);
  L.push('');
  return L.join('\n');
}

async function main() {
  const a = parseArgs(process.argv);
  const pkgs = readList(a.list, a.limit);
  fs.mkdirSync(a.outDir, { recursive: true });
  const jsonlPath = path.join(a.outDir, 'results.jsonl');
  const reportPath = path.join(a.outDir, 'report.md');
  const stream = fs.createWriteStream(jsonlPath);

  console.error(`validating ${pkgs.length} packages (concurrency ${a.concurrency}, timeout ${a.timeoutMs}ms) …`);
  const results = [];
  const t0 = Date.now();
  await runPool(pkgs, a.concurrency, a.timeoutMs, (rec) => {
    results.push(rec);
    stream.write(JSON.stringify(rec) + '\n');
  });
  await new Promise((res) => stream.end(res));
  const wallMs = Date.now() - t0;

  const report = buildReport(a, pkgs, results, wallMs);
  fs.writeFileSync(reportPath, report + '\n');

  const allBlocks = results.filter((r) => r.decision === 'block');
  const vulnBlocks = allBlocks.filter(isVulnBlock);
  const defensibleBlocks = allBlocks.filter((r) => !isVulnBlock(r) && isDefensibleBlock(r));
  const heuristicBlocks = allBlocks.filter((r) => !isVulnBlock(r) && !isDefensibleBlock(r));
  const counts = results.reduce((m, r) => ((m[r.decision] = (m[r.decision] || 0) + 1), m), {});
  console.error('');
  console.error('=== summary ===');
  console.error(counts);
  console.error(`heuristic false blocks: ${heuristicBlocks.length}  (must be 0)`);
  console.error(`correct blocks (known CVE): ${vulnBlocks.length}`);
  console.error(`defensible blocks (documented): ${defensibleBlocks.length}${defensibleBlocks.length ? ' -> ' + defensibleBlocks.map((r) => r.package).join(', ') : ''}`);
  if (heuristicBlocks.length) console.error('  ->', heuristicBlocks.map((r) => r.package).join(', '));
  console.error(`report: ${path.relative(ROOT, reportPath)}`);
  console.error(`raw:    ${path.relative(ROOT, jsonlPath)}`);
  if (a.emitStats) {
    const artifact = buildStatsArtifact(a, results, heuristicBlocks);
    fs.mkdirSync(path.dirname(a.emitStats), { recursive: true });
    fs.writeFileSync(a.emitStats, JSON.stringify(artifact, null, 2) + '\n');
    console.error(`stats:  ${path.relative(ROOT, a.emitStats)}  (review by hand before copying into website/stats/data/)`);
  }
  process.exit(heuristicBlocks.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
