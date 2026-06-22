# pkgxray

Local CLI + MCP server for triaging whether an AI coding-agent extension, Codex
plugin, Claude Code extension, or npm package is safe to install — from supplied
evidence or by fetching a real npm tarball into a sandboxed quarantine.

## Install

```bash
npm install -g pkgxray
# or use one-shot via npx:
npx pkgxray guard npm:some-package@1.2.3
```

It is intentionally conservative. It only reports evidence it can cite from
metadata or source text, and it returns one of:

- `safe`: no high- or medium-risk indicators in the provided evidence
- `review`: incomplete evidence or privileged capability needing manual review
- `block`: high-severity indicators such as prompt injection, credential access,
  persistence, obfuscation plus execution, or likely exfiltration

## CLI

```bash
pkgxray --file examples/evidence.json
pkgxray --format json --file examples/evidence.json

# Audit a whole project's lockfile in one command (batch OSV query)
pkgxray audit package-lock.json
pkgxray audit yarn.lock
pkgxray audit pnpm-lock.yaml
pkgxray audit package.json

# --deep runs the full static / GitHub layer on each blocked dep too
pkgxray audit package-lock.json --deep
```

Guard an extension before handing it to an agent:

```bash
pkgxray guard ./some-local-extension
pkgxray guard npm:some-mcp-server@1.2.3 --format json
pkgxray guard ./some-local-extension --promote-to ./approved/some-local-extension
pkgxray guard npm:is-number@7.0.0 --no-source-scan --format json
```

The guard flow stages the extension in a private quarantine directory, audits
that staged copy, and only promotes it when policy allows. It does not run
`npm install`, package lifecycle scripts, build steps, or extension code.

For npm references, guard order is:

1. Resolve package metadata from the npm registry.
2. Query OSV for the exact package/version.
3. If OSV reports vulnerabilities, block before tarball download.
4. If no vulnerabilities are reported, download and extract the tarball into
   quarantine.
5. Collect source evidence and run the static audit unless `--no-source-scan`
   is set.

The JSON output includes timing fields:

- `stageMs`: local copy or npm metadata resolution
- `vulnerabilityPrecheckMs`: OSV lookup time
- `downloadMs`: tarball download, hash, and extraction time
- `sourceCollectionMs`: capped source-file collection time
- `auditMs`: static audit time

Guard decisions:

- `allow`: safe verdict; promotion can happen
- `review`: do not promote by default; a human should inspect the quarantine
- `block`: high-severity evidence; do not install

By default, only `safe` promotes. Use `--policy allow-review` only when you want
review-grade packages copied into the destination for manual handling.

Input JSON:

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
    "pkgxray": {
      "command": "pkgxray-mcp"
    }
  }
}
```

The server exposes two tools:

- `audit_agent_extension_supply_chain` — static heuristics on supplied evidence
- `guard_agent_extension_install` — stage, vuln-check, audit a real package

Tool arguments:

- `packageName`: optional package or extension name
- `npmMetadata`: optional npm metadata object or text
- `githubMetadata`: optional GitHub metadata object or text
- `webPresence`: optional web presence object or text
- `sourceFiles`: required map of file path to source text, or array of file objects
- `outputFormat`: `markdown` or `json`

`guard_agent_extension_install` accepts `reference`, optional `quarantineRoot`,
optional `promoteTo`, `policy`, `force`, and `outputFormat`.

## Static heuristics — calibration

The heuristics are calibrated to keep legitimate packages out of `block`. Real
malicious patterns that gate the verdict:

- **block** (HIGH) — prompt-injection text in README/docs, credential reads in
  proximity to a filesystem-read primitive, persistence writes to shell rc /
  cron / launchagents, dynamic exec + hardcoded IP/shortener/webhook target,
  bulk `process.env` harvest in the same file as outbound network.
- **review** (MEDIUM) — install / postinstall / prepare lifecycle scripts,
  dynamic eval / new Function / vm, clipboard read/write, missing
  package.json, missing entrypoint source.
- **info** — child_process / fetch / network in isolation. Common in build
  tools and CLIs; recorded but does not gate the verdict.

`.d.ts`, `.map`, `.min.js`, and `.lock` files are skipped entirely.

## JSON output schema (v1)

All JSON outputs carry a top-level `schemaVersion: 1` field. Within the `0.x`
series, fields are **additive only** — new fields may appear, existing
fields keep their type and meaning. Removals or type changes bump
`schemaVersion`. Build downstream tooling against this guarantee.

### `audit` / `--file evidence.json` shape

```jsonc
{
  "schemaVersion": 1,
  "verdict": "safe" | "review" | "block",
  "grade": "A+" | "A" | ... | "F",
  "score": 0-100,
  "parameters": { /* per-parameter scores */ },
  "summary": "string",
  "packageName": "string | null",
  "riskBands": [
    {
      "band": "lifecycle-script" | "dynamic-eval" | "credential-access" | "persistence"
            | "exfiltration" | "obfuscation" | "prompt-injection" | "lonely-maintainer"
            | "github-mismatch" | "github-archived" | "github-young" | "github-lonely"
            | "github-stale" | "npm-vs-github-divergence" | "npm-vs-github-clean"
            | "known-vulnerability" | "incomplete-evidence" | "missing-metadata"
            | "bulk-env" | "clipboard",
      "label": "string",
      "severity": "high" | "medium" | "low" | "info",
      "count": number,
      "examples": ["file/path", ...],
      "rationale": "string"
    }
  ],
  "findings": [
    {
      "severity": "high" | "medium" | "low" | "info",
      "category": "string",
      "file": "string",
      "snippet": "string",
      "rationale": "string"
    }
  ]
}
```

### `guard` shape

```jsonc
{
  "schemaVersion": 1,
  "decision": "allow" | "review" | "block",
  "reference": "string",
  "resolved": {
    "type": "npm" | "github" | "local",
    "packageName": "string",
    "version": "string | null",
    "sha256": "hex (npm/github)",
    "integrity": "sha512-... (npm)",
    "tarballUrl": "string"
  },
  "githubMetadata": { /* full_name, stars, forks, created_at, ... */ } | null,
  "npmVsGithubDiff": {
    "compared": boolean,
    "githubRef": "string",
    "counts": { "matched": n, "mismatched": n, "extraSource": n, ... },
    "suspiciousExtras": [{ "path": "string", "category": "string", "size": n }],
    "overlapRatio": 0..1
  } | null,
  "vulnerabilityPrecheck": {
    "enabled": boolean,
    "vulnerabilityCount": n,
    "vulnerabilities": [...]
  },
  "timings": { "stageMs": n, "downloadMs": n, ... },
  "quarantinePath": "string",
  "stagedPath": "string",
  "promotedPath": "string | null",
  "report": { /* see "audit" shape above */ }
}
```

Exit codes: `0` = safe/allow, `2` = block, `3` = review.

### `audit <lockfile>` shape

```jsonc
{
  "schemaVersion": 1,
  "file": "string",
  "format": "npm" | "yarn" | "pnpm" | "package-json",
  "totalDeps": n,
  "uniqueDeps": n,
  "timings": { "osvMs": n, "deepMs": n, "totalMs": n },
  "summary": { "safe": n, "reviewed": n, "blocked": n },
  "worstDecision": "safe" | "review" | "block",
  "results": [
    {
      "name": "string",
      "version": "string",
      "paths": ["string", ...],
      "decision": "safe" | "review" | "block",
      "vulnerabilities": [{ "id": "GHSA-...", "aliases": [...] }],
      "deep": null | {
        "verdict": "string",
        "grade": "string",
        "riskBands": [...]
      }
    }
  ]
}
```

Exit codes: `0` = all safe, `2` = at least one block, `3` = at least one review.

## Browser Extension

The `browser-extension/` folder is a Chrome-compatible Manifest V3 unpacked
extension. It runs entirely locally and requests no browser permissions.

Load the `browser-extension/` folder from a checkout of this repo as an
unpacked extension.

In Chrome:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Choose Load unpacked.
4. Select the `browser-extension` folder above.

In Dia, try the same flow if Dia exposes Chromium extension management. If Dia
does not currently allow unpacked extensions, use Chrome for testing and keep the
MCP/CLI version for agent workflows.

## Self-hostable cache server

Every `pkgxray guard` and `pkgxray audit --deep` run fetches GitHub repo
metadata and (for github-archive references) repo tarballs. In CI, that
duplicates traffic across every runner, every commit, every monorepo dep.
Run a shared cache server on the team's private network and point CI at it
to collapse that traffic into one fetch per (repo, ref) per TTL window.

```bash
# Start on the cache host (zero deps, just Node):
pkgxray-cache --port 8819 --cache-dir /var/cache/pkgxray

# Point clients at it (env var, no code changes):
export PKGXRAY_CACHE_URL=http://cache.internal:8819
pkgxray guard npm:is-number@7.0.0
pkgxray audit package-lock.json --deep
```

Routes:

- `GET /github/repos/{owner}/{repo}` — proxies `api.github.com/repos/...`
  with a 1-hour TTL. Returns the raw GitHub JSON. Sets
  `x-pkgxray-cache: HIT|MISS`.
- `GET /github/tarball/{owner}/{repo}/{ref}` — proxies
  `codeload.github.com/.../tar.gz/{ref}` with a 24-hour TTL. Streams the
  bytes; never buffers the whole tarball in memory.
- `GET /healthz` — `{"ok": true, "version": "..."}` for liveness probes.

Behaviour:

- Cache layout is `<cache-dir>/github/repos/<owner>/<repo>.json` and
  `<cache-dir>/github/tarballs/<owner>/<repo>/<ref>.tgz`. Same on-disk
  shape as the local `~/.cache/pkgxray/` cache.
- Concurrent requests for the same uncached resource share a single
  upstream fetch — N CI runners that hit a cold cache at the same instant
  still produce exactly one upstream call.
- A 404 from upstream is forwarded to the client and **not** persisted, so
  a missing-then-published repo is picked up on the next request.
- The client (`pkgxray`) automatically routes through the cache when
  `PKGXRAY_CACHE_URL` is set; with the env var unset the default path runs
  with zero overhead — no extra hop, no extra parsing.
- Pass `--upstream-github-api=URL` / `--upstream-codeload=URL` to point the
  server at an alternate upstream (useful for testing or GitHub Enterprise).
- Set `PKGXRAY_CACHE_GITHUB_TOKEN` on the server to use a team GitHub
  token for the upstream calls (5000 req/hr instead of 60). Per-client
  tokens can also be forwarded via the `x-pkgxray-github-token` header.

**Trust model — read this before deploying.** The cache server is a
transparent caching proxy, not an auth boundary. It has no login, no rate
limit, and no per-client identity. Anyone who can reach it can read every
cached repo and tarball and trigger upstream fetches against your team
GitHub token's rate limit. **Run it on a private network or behind a
reverse proxy (nginx, Caddy, Cloudflare Access, your VPC's load balancer)
that enforces your own authentication and IP allowlist.** Treat the cache
directory like any other build artifact cache — fine to nuke at any time,
do not put it on a public network.

## Local Development

```bash
npm run build:browser
npm test
npm run audit:evidence -- --file examples/evidence.json
```
