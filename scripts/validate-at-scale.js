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
//
// Outputs (default --out-dir validation/results/):
//   results.jsonl      one JSON object per package (decision, grade, findings)
//   report.md          human-readable summary with the false-block list
// Exit code: 0 if false blocks == 0, else 1 (so CI can gate on it).

const { spawn } = require('node:child_process');
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
    outDir: path.join(ROOT, 'validation', 'results'),
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--list': a.list = path.resolve(v); i++; break;
      case '--limit': a.limit = Number(v); i++; break;
      case '--concurrency': a.concurrency = Number(v); i++; break;
      case '--timeout-ms': a.timeoutMs = Number(v); i++; break;
      case '--out-dir': a.outDir = path.resolve(v); i++; break;
      case '--help': case '-h':
        console.log('node scripts/validate-at-scale.js [--list f] [--limit N] [--concurrency N] [--timeout-ms N] [--out-dir d]');
        process.exit(0);
      default:
        console.error('unknown arg:', argv[i]); process.exit(2);
    }
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
  L.push('# pkgxray at-scale validation — top-1000 npm packages');
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
  process.exit(heuristicBlocks.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
