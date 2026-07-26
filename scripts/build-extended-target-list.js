#!/usr/bin/env node
'use strict';
// Build the EXTENDED calibration target list — the "next N most-downloaded"
// npm packages beyond the top-1000, so the aggregate at-scale scan covers a
// broad popular population (not just the top-1000 false-block calibration list).
//
// Source of truth for popularity: the committed `npm-high-impact` download-rank
// pool (vendored alongside this run for reproducibility), which is npm's most-
// downloaded packages in descending last-week-download order — the same signal
// the top-1000 list was re-ranked by. We take that order, drop anything already
// in the top-1000 or MCP lists, resolve each survivor to its `dist-tags.latest`
// (abbreviated packument, no download/execution), and keep going until we have
// --want resolved, pinned `name@version` targets. Unresolvable names (404 /
// unpublished) are skipped and counted, never emitted as a target.
//
// Zero-dependency, like the rest of pkgxray.
//
// Usage:
//   node scripts/build-extended-target-list.js \
//     --pool validation/calibration-2026-07-22/pool-npm-high-impact-1.13.0.json \
//     --exclude validation/calibration-2026-07-19/top1000-targets.txt \
//     --exclude validation/mcp-registry-targets.txt \
//     --want 4000 --concurrency 24 \
//     --out validation/calibration-2026-07-22/extended-targets.txt

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = { pool: null, exclude: [], want: 4000, concurrency: 24, out: null, poolVersion: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--pool': a.pool = path.resolve(v); i++; break;
      case '--exclude': a.exclude.push(path.resolve(v)); i++; break;
      case '--want': a.want = Number(v); i++; break;
      case '--concurrency': a.concurrency = Number(v); i++; break;
      case '--out': a.out = path.resolve(v); i++; break;
      case '--pool-version': a.poolVersion = v; i++; break;
      default: console.error('unknown arg:', argv[i]); process.exit(2);
    }
  }
  if (!a.pool || !a.out) { console.error('need --pool and --out'); process.exit(2); }
  return a;
}

// name@version -> name ; plain name -> name
function bareName(line) {
  const l = line.trim();
  if (!l || l.startsWith('#')) return null;
  const at = l.lastIndexOf('@');
  return at > 0 ? l.slice(0, at) : l; // lastIndexOf('@')>0 keeps scoped @scope/name intact
}

function readNames(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(bareName).filter(Boolean);
}

// Resolve dist-tags.latest via the abbreviated packument (small, no tarball).
function resolveLatest(name) {
  return new Promise((resolve) => {
    const enc = name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
    const req = https.get({
      host: 'registry.npmjs.org',
      path: '/' + enc,
      headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'pkgxray-calibration' },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const latest = j['dist-tags'] && j['dist-tags'].latest;
          resolve(latest ? { name, version: latest } : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function main() {
  const a = parseArgs(process.argv);
  const pool = JSON.parse(fs.readFileSync(a.pool, 'utf8'));
  const excl = new Set();
  for (const f of a.exclude) for (const n of readNames(f)) excl.add(n);
  const candidates = pool.filter((n) => !excl.has(n));
  console.error(`pool ${pool.length}, excluded ${excl.size}, candidates ${candidates.length}, want ${a.want} resolved`);

  const resolved = [];
  let unresolved = 0, idx = 0;
  const total = candidates.length;

  async function worker() {
    while (idx < total && resolved.length < a.want) {
      const name = candidates[idx++];
      const r = await resolveLatest(name);
      if (r) resolved.push(r); else unresolved++;
      if ((resolved.length + unresolved) % 100 === 0) {
        process.stderr.write(`\r  resolved ${resolved.length}/${a.want} (skipped ${unresolved}) …`);
      }
    }
  }
  await Promise.all(Array.from({ length: a.concurrency }, worker));
  process.stderr.write('\n');

  // Preserve download-rank order of the pool.
  const order = new Map(pool.map((n, i) => [n, i]));
  resolved.sort((x, y) => order.get(x.name) - order.get(y.name));
  const lines = resolved.slice(0, a.want).map((r) => `${r.name}@${r.version}`);

  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  fs.writeFileSync(a.out, lines.join('\n') + '\n');
  const meta = {
    generated: 'via scripts/build-extended-target-list.js',
    pool: path.relative(ROOT, a.pool).replace(/\\/g, '/'),
    poolVersion: a.poolVersion || 'npm-high-impact',
    poolSize: pool.length,
    excludedFrom: a.exclude.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')),
    excludedCount: excl.size,
    requested: a.want,
    emitted: lines.length,
    unresolvedSkipped: unresolved,
    scanned_at_probe: candidates.length ? Math.min(idx, total) : 0,
  };
  fs.writeFileSync(a.out.replace(/\.txt$/, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.error(`emitted ${lines.length} targets -> ${path.relative(ROOT, a.out)} (skipped ${unresolved} unresolvable)`);
}

main().catch((e) => { console.error(e); process.exit(2); });
