#!/usr/bin/env node
'use strict';
// Build the top-PyPI validation target list from the canonical download-ranking
// dataset. Zero-dependency, like the rest of pkgxray.
//
// Source: hugovk/top-pypi-packages — a monthly snapshot of the most-downloaded
// PyPI projects derived from the public BigQuery download stats. The JSON is
// `{ "last_update": "...", "rows": [ { "download_count": N, "project": "name" }, ... ] }`,
// already sorted by download_count descending. We take the top `--cap` project
// names (PEP 503-normalized), the PyPI analog of validation/top1000.txt.
//
// Usage:
//   node scripts/build-pypi-list.js [--cap N] [--out <file>] [--url <url>]
//
// Outputs (default validation/):
//   top-pypi-1000.txt            one project name per line, ranked
//   top-pypi-1000.meta.json      provenance: source, fetch date, counts

const fs = require('node:fs');
const path = require('node:path');
const { normalizePypiName } = require('../src/lockfile');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_URL = 'https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json';

function parseArgs(argv) {
  const a = {
    cap: 1000,
    out: path.join(ROOT, 'validation', 'top-pypi-1000.txt'),
    url: DEFAULT_URL,
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--cap': a.cap = Number(v); i++; break;
      case '--out': a.out = path.resolve(v); i++; break;
      case '--url': a.url = v; i++; break;
      case '--help': case '-h':
        console.log('node scripts/build-pypi-list.js [--cap N] [--out <file>] [--url <url>]');
        process.exit(0);
      default:
        console.error('unknown arg:', argv[i]); process.exit(2);
    }
  }
  return a;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const a = parseArgs(process.argv);
  const fetchedAt = new Date().toISOString().slice(0, 10);

  console.error(`fetching top-PyPI download ranking from ${a.url} …`);
  const data = await getJson(a.url);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length === 0) throw new Error('dataset had no rows — unexpected shape');

  // Rows arrive ranked by download_count desc. Normalize (PEP 503) and dedupe,
  // preserving rank order, then cap.
  const seen = new Set();
  const names = [];
  for (const r of rows) {
    const raw = r && (r.project || r.name);
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const name = normalizePypiName(raw);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= a.cap) break;
  }

  const header = [
    '# Top-PyPI most-downloaded packages (validation corpus)',
    `# Source: ${a.url} (hugovk/top-pypi-packages — public download-stats ranking).`,
    `# Dataset last_update: ${data.last_update || 'unknown'} · fetched ${fetchedAt}.`,
    '# Some entries may since be yanked/deprecated; the harness records those as errors, not blocks.',
    '# One PEP 503-normalized project name per line. Used by scripts/validate-at-scale.js --ecosystem pypi.',
    '# Regenerate: node scripts/build-pypi-list.js',
  ];
  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  fs.writeFileSync(a.out, header.concat(names).join('\n') + '\n');

  const metaPath = a.out.replace(/\.txt$/, '') + '.meta.json';
  fs.writeFileSync(metaPath, JSON.stringify({
    source: a.url,
    dataset_last_update: data.last_update || null,
    fetched_date: fetchedAt,
    rows_in_source: rows.length,
    listed: names.length,
    order: 'ranked by public download count (descending), PEP 503-normalized, deduped',
    list: 'top-pypi',
    command: 'node scripts/build-pypi-list.js',
  }, null, 2) + '\n');

  console.error(`  ${path.relative(ROOT, a.out)} — ${names.length} packages (from ${rows.length} ranked rows)`);
  console.error(`  ${path.relative(ROOT, metaPath)}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
