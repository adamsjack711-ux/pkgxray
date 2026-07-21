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

async function fetchAllServers() {
  const servers = [];
  let cursor = null;
  let pages = 0;
  do {
    const url = `${REGISTRY}?version=latest&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await getJson(url);
    servers.push(...(page.servers || []));
    cursor = page.metadata && page.metadata.nextCursor;
    pages++;
    process.stderr.write(`\r  fetched ${servers.length} server records (${pages} pages) …`);
  } while (cursor);
  process.stderr.write('\n');
  return servers;
}

async function main() {
  const a = parseArgs(process.argv);
  const fetchedAt = new Date().toISOString().slice(0, 10);

  console.error(`fetching latest server versions from ${REGISTRY} …`);
  const entries = await fetchAllServers();

  // Dedupe by npm identifier. The registry can list the same npm package under
  // more than one server record; keep the first seen (latest-version listing).
  const byPkg = new Map();
  let activeServers = 0;
  for (const e of entries) {
    const official = (e._meta && e._meta[OFFICIAL_META]) || {};
    if (official.status && official.status !== 'active') continue;
    activeServers++;
    for (const p of (e.server && e.server.packages) || []) {
      if (p.registryType !== 'npm' || !p.identifier) continue;
      if (!byPkg.has(p.identifier)) {
        byPkg.set(p.identifier, { name: p.identifier, version: p.version || null, server: e.server.name });
      }
    }
  }

  // Deterministic order (the registry has no download ranking), then cap to
  // what one validate-at-scale pass covers.
  const all = [...byPkg.values()].sort((x, y) => x.name.localeCompare(y.name, 'en'));
  const listed = all.slice(0, a.cap);

  const header = [
    '# MCP-cohort validation targets — npm packages published in the official MCP Registry.',
    `# Source: ${REGISTRY} (latest versions, active servers) · fetched ${fetchedAt}.`,
    `# ${listed.length} of ${all.length} npm-packaged servers (alphabetical, capped for one scan pass).`,
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
    server_records_seen: entries.length,
    active_server_records: activeServers,
    npm_packages_found: all.length,
    listed: listed.length,
    order: 'alphabetical by npm identifier (registry has no download ranking)',
    list: 'mcp-registry',
    command: 'node scripts/build-mcp-target-list.js',
  }, null, 2) + '\n');

  console.error(`  ${path.relative(ROOT, a.out)} — ${listed.length} targets (of ${all.length} npm-packaged servers, ${activeServers} active server records)`);
  console.error(`  ${path.relative(ROOT, metaPath)}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
