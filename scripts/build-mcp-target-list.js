#!/usr/bin/env node
'use strict';
// Build the MCP-cohort validation target list from the official MCP Registry.
// Zero-dependency, like the rest of pkgxray.
//
// Pages https://registry.modelcontextprotocol.io/v0/servers (latest versions
// only), keeps active servers that ship an npm package, dedupes by npm
// identifier, sorts deterministically, and caps the list to one scan pass.
// Emits inputs only — names and versions, no verdicts.
//
// Usage:
//   node scripts/build-mcp-target-list.js [--cap N] [--out <file>]
//
// Outputs (default validation/):
//   mcp-registry-targets.txt        one name@version per line
//   mcp-registry-targets.meta.json  provenance: source, fetch date, counts

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

function parseArgs(argv) {
  const a = {
    cap: 300,
    out: path.join(ROOT, 'validation', 'mcp-registry-targets.txt'),
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--cap': a.cap = Number(v); i++; break;
      case '--out': a.out = path.resolve(v); i++; break;
      case '--help': case '-h':
        console.log('node scripts/build-mcp-target-list.js [--cap N] [--out <file>]');
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

// Page in registry cursor order (stable: alphabetical by server name),
// collecting unique npm identifiers until the cap is met. The registry API is
// slow per listing page (~30s+), so full enumeration is deliberately avoided —
// for a given registry state the collected prefix is deterministic anyway.
// Dedupes by npm identifier: the registry can list the same npm package under
// more than one server record; first seen wins (latest-version listing).
async function collectNpmPackages(cap) {
  const byPkg = new Map();
  let cursor = null;
  let pages = 0;
  let records = 0;
  let activeRecords = 0;
  let exhausted = true;
  do {
    const url = `${REGISTRY}?version=latest&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await getJson(url);
    for (const e of page.servers || []) {
      records++;
      const official = (e._meta && e._meta[OFFICIAL_META]) || {};
      if (official.status && official.status !== 'active') continue;
      activeRecords++;
      for (const p of (e.server && e.server.packages) || []) {
        if (p.registryType !== 'npm' || !p.identifier) continue;
        if (!byPkg.has(p.identifier)) {
          byPkg.set(p.identifier, { name: p.identifier, version: p.version || null, server: e.server.name });
        }
      }
    }
    cursor = page.metadata && page.metadata.nextCursor;
    pages++;
    process.stderr.write(`\r  ${byPkg.size}/${cap} npm packages from ${records} server records (${pages} pages) …`);
    if (byPkg.size >= cap) { exhausted = !cursor; break; }
  } while (cursor);
  process.stderr.write('\n');
  return { byPkg, pages, records, activeRecords, exhausted };
}

async function main() {
  const a = parseArgs(process.argv);
  const fetchedAt = new Date().toISOString().slice(0, 10);

  console.error(`fetching latest server versions from ${REGISTRY} …`);
  const { byPkg, pages, records, activeRecords, exhausted } = await collectNpmPackages(a.cap);

  // Stable file order for diffs; cap to what one validate-at-scale pass covers.
  const all = [...byPkg.values()].sort((x, y) => x.name.localeCompare(y.name, 'en'));
  const listed = all.slice(0, a.cap);

  const header = [
    '# MCP-cohort validation targets — npm packages published in the official MCP Registry.',
    `# Source: ${REGISTRY} (latest versions, active servers) · fetched ${fetchedAt}.`,
    `# ${listed.length} npm-packaged servers, collected in registry cursor order${exhausted ? ' (registry exhausted)' : ' until the cap'}, sorted by identifier.`,
    '# Inputs only — no verdicts. Regenerate: node scripts/build-mcp-target-list.js',
  ];
  const lines = listed.map((p) => (p.version ? `${p.name}@${p.version}` : p.name));
  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  fs.writeFileSync(a.out, header.concat(lines).join('\n') + '\n');

  const metaPath = a.out.replace(/\.txt$/, '') + '.meta.json';
  fs.writeFileSync(metaPath, JSON.stringify({
    source: REGISTRY,
    query: 'version=latest, status=active, packages[].registryType=npm',
    fetched_date: fetchedAt,
    pages_fetched: pages,
    server_records_seen: records,
    active_server_records: activeRecords,
    enumeration: exhausted ? 'registry exhausted' : 'stopped at cap (registry cursor order — alphabetical by server name)',
    listed: listed.length,
    order: 'file sorted by npm identifier for stable diffs; registry has no download ranking',
    list: 'mcp-registry',
    command: 'node scripts/build-mcp-target-list.js',
  }, null, 2) + '\n');

  console.error(`  ${path.relative(ROOT, a.out)} — ${listed.length} targets (${records} server records over ${pages} pages${exhausted ? ', registry exhausted' : ''})`);
  console.error(`  ${path.relative(ROOT, metaPath)}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
