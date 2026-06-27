# pkgxray

Local CLI + MCP server for triaging whether an AI coding-agent extension, Codex
plugin, Claude Code extension, or npm package is safe to install — from supplied
evidence or by fetching a real npm tarball into a sandboxed quarantine.
Zero-dependency Node, runs entirely locally.

## Install

```bash
npm install -g pkgxray
# or one-shot via npx:
npx pkgxray guard npm:some-package@1.2.3
```

It is intentionally conservative — it only reports evidence it can cite from
metadata or source text. Every verdict is one of:

- `safe` — no high- or medium-risk indicators
- `review` — incomplete evidence or privileged capability needing manual review
- `block` — high-severity indicators (prompt injection, credential access,
  persistence, obfuscation + execution, likely exfiltration)

## CLI

```bash
# Audit supplied evidence
pkgxray --file examples/evidence.json
pkgxray --format json --file examples/evidence.json

# Audit a whole project's lockfile (batch OSV query)
pkgxray audit package-lock.json      # also: yarn.lock, pnpm-lock.yaml, package.json
pkgxray audit package-lock.json --deep   # full static/GitHub layer on each blocked dep

# Guard an extension before handing it to an agent
pkgxray guard ./some-local-extension
pkgxray guard npm:some-mcp-server@1.2.3 --format json
pkgxray guard ./ext --promote-to ./approved/ext
```

The guard flow stages the extension in a private quarantine directory, audits
the staged copy, and only promotes it when policy allows. It does **not** run
`npm install`, lifecycle scripts, build steps, or extension code.

For npm references the order is: resolve registry metadata → query OSV for the
exact version → block before download if vulnerabilities exist → otherwise
download + extract the tarball into quarantine → collect source and run the
static audit (unless `--no-source-scan`).

Guard decisions: `allow` (safe, promotion ok), `review` (inspect quarantine
first), `block` (do not install). By default only `safe` promotes; use
`--policy allow-review` to also promote review-grade packages.

Input evidence JSON:

```json
{
  "packageName": "example-extension",
  "npmMetadata": {},
  "githubMetadata": {},
  "webPresence": {},
  "sourceFiles": {
    "package.json": "{\"name\":\"example-extension\"}",
    "index.js": "module.exports = {}"
  }
}
```

## MCP Server

Use the stdio server from any MCP-capable agent:

```json
{
  "mcpServers": {
    "pkgxray": { "command": "pkgxray-mcp" }
  }
}
```

Tools exposed:

- `audit_agent_extension_supply_chain` — static heuristics on supplied evidence
  (`sourceFiles` required; optional `packageName`, `npmMetadata`,
  `githubMetadata`, `webPresence`, `knownVulnerabilities`,
  `provenanceAttestation`, `npmVsGithubDiff`, `outputFormat`)
- `guard_agent_extension_install` — stage, vuln-check, and audit a real package
  (`reference` required; optional `quarantineRoot`, `promoteTo`, `policy`,
  `force`, `sourceScan`, `vulnerabilityCheck`, `deep`, `outputFormat`). Fetches
  npm provenance attestation automatically and cross-checks it.
- `audit_lockfile_supply_chain` — batch OSV scan every dep in a lockfile
  (`lockfilePath` required; optional `deep`, `deepAll`, `vulnerabilityCheck`,
  `outputFormat`)
- `triage_lockfile_supply_chain` — non-interactive triage that records each
  flagged dep as `allow`/`block` into a sibling `.pkgxray.lock` (`lockfilePath`
  and `auto` required; optional `includeSafe`, `outputFormat`)

## Static heuristics

Calibrated to keep legitimate packages out of `block`:

- **block** (HIGH) — prompt-injection text in docs, credential reads near a
  filesystem-read primitive, persistence writes (shell rc / cron /
  launchagents), dynamic exec + hardcoded IP/shortener/webhook, bulk
  `process.env` harvest in the same file as outbound network.
- **review** (MEDIUM) — install/postinstall/prepare scripts, dynamic
  eval/`new Function`/vm, clipboard access, missing package.json or entrypoint.
- **info** — child_process/fetch/network in isolation. Recorded, does not gate.

`.d.ts`, `.map`, `.min.js`, and `.lock` files are skipped.

## JSON output

All JSON output carries `schemaVersion: 1`. Within `0.x`, fields are **additive
only** — new fields may appear; existing fields keep their type and meaning.
Build downstream tooling against that guarantee.

Run any command with `--format json` to see the full shape. Top-level fields:

- **audit / `--file`** — `verdict`, `grade`, `score`, `parameters`, `summary`,
  `riskBands[]`, `findings[]`
- **guard** — `decision`, `resolved` (type/sha256/integrity/tarballUrl),
  `githubMetadata`, `npmVsGithubDiff`, `vulnerabilityPrecheck`, `timings`,
  `quarantinePath`, `promotedPath`, `report` (the audit shape above)
- **audit `<lockfile>`** — `file`, `format`, `totalDeps`, `uniqueDeps`,
  `summary`, `worstDecision`, `results[]` (per-dep decision + vulnerabilities)

Exit codes: `0` = safe/allow, `2` = block, `3` = review.

## Performance

pkgxray is built to be cheap enough to run on every install. Measured on an
Apple M1 (Node 26), single package:

| Operation | Time |
|---|---|
| Static audit of supplied evidence (no network) | ~140 ms end-to-end (~25 ms scan) |
| `guard` a fresh npm package, cold cache | ~1.1 s |
| `guard` same package, warm cache | ~0.85 s (≈25% faster) |

Almost all of `guard`'s time is network round-trips (npm registry, OSV, GitHub
metadata, provenance) — the local analysis itself is ~25 ms. Point CI at a
shared [cache server](#self-hostable-cache-server) to collapse the repeated
GitHub fetches across runners. Numbers vary with network and machine; treat
them as ballpark.

## Browser Extension

`browser-extension/` is a Chrome-compatible Manifest V3 unpacked extension. It
runs entirely locally and requests no browser permissions. Load it via
`chrome://extensions` → enable Developer Mode → **Load unpacked** → select the
`browser-extension/` folder. (In Dia, try the same flow if it supports unpacked
Chromium extensions; otherwise use Chrome.)

## Self-hostable cache server

Every `guard` and `audit --deep` run fetches GitHub repo metadata and tarballs.
In CI that duplicates traffic across runners. Run a shared cache on your private
network and collapse it into one fetch per (repo, ref) per TTL window:

```bash
# On the cache host (zero deps, just Node):
pkgxray-cache --port 8819 --cache-dir /var/cache/pkgxray

# Point clients at it (no code changes):
export PKGXRAY_CACHE_URL=http://cache.internal:8819
pkgxray audit package-lock.json --deep
```

Routes: `GET /github/repos/{owner}/{repo}` (1h TTL), `GET
/github/tarball/{owner}/{repo}/{ref}` (24h TTL, streamed), `GET /healthz`.
Concurrent requests for the same uncached resource share one upstream fetch;
404s are forwarded but not persisted. With `PKGXRAY_CACHE_URL` unset, clients
run the default path with zero overhead. Set `PKGXRAY_CACHE_GITHUB_TOKEN` on the
server (or forward `x-pkgxray-github-token` per client) for 5000 req/hr.

> **Trust model — read before deploying.** The cache server is a transparent
> caching proxy, **not** an auth boundary. It has no login, rate limit, or
> per-client identity. Run it on a private network or behind a reverse proxy
> (nginx, Caddy, Cloudflare Access) that enforces your own auth. Treat the cache
> directory like any build-artifact cache — never put it on a public network.

## Local Development

```bash
npm run build:browser
npm test
npm run audit:evidence -- --file examples/evidence.json
```
