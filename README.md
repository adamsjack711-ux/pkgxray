<div align="center">

# pkgxray

**Analyze packages before you install them.**

Local software supply-chain security for AI agents & npm packages.
Zero-dependency Node, runs entirely on your machine, never executes untrusted code.

<img src="docs/architecture.svg" alt="pkgxray architecture: inputs flow through the acquisition, quarantine, static-analysis and policy engines to a SAFE / REVIEW / BLOCK verdict" width="820">

</div>

```bash
npm install -g pkgxray

pkgxray guard npm:some-package@1.2.3
```

That's the whole loop: point it at a package, get a `SAFE` / `REVIEW` / `BLOCK`
verdict with cited evidence — before a single line of that package runs.

---

## Why pkgxray exists

Modern software depends on thousands of third-party packages, and **AI coding
assistants increasingly install them automatically** — often without a human
ever reading the code.

Traditional antivirus inspects what *executes*. **pkgxray inspects what gets
*installed*.** Rather than running untrusted code in the hope of catching bad
behavior, it performs evidence-based static analysis on a package's metadata,
source, provenance, and published artifact *before* the software reaches your
machine.

It is intentionally conservative: it only reports evidence it can cite from
metadata or source text, and stages everything in a sandboxed quarantine that
never runs install scripts or package code. You get triage in ~1 s/package with
no execution risk.

---

## Detection Engine

pkgxray correlates three classes of signal and resolves them into one verdict.

### Supply-chain intelligence
- **Known CVEs (OSV)** — queries OSV for the exact `name@version` and blocks
  *before downloading the tarball*. `pkgxray guard npm:axios@1.7.7` returns
  **BLOCK** on published advisories without ever fetching the code.
- **Provenance** — verifies npm's sigstore/SLSA attestation links the package to
  its claimed source repo.
- **npm ↔ GitHub divergence** — diffs the published tarball against the tagged
  GitHub source and flags files that exist only in (or differ from) the npm
  artifact.
- **Registry metadata** — install/lifecycle scripts, maintainer and version
  signals.

### Static code analysis
- **Credential & secret access** — reads of `.ssh`, `.aws`, `.npmrc`, `.env`,
  keychains, browser stores, wallets, and bulk `process.env` harvesting.
- **Persistence** — writes to shell rc files, cron, launch agents, systemd,
  registry run keys.
- **Obfuscation + execution** — packed/encoded blobs with `eval`,
  `new Function`, `vm`, `atob` + exec, and paths assembled from split string
  fragments.
- **Trojan Source** — bidi-override / zero-width Unicode hidden in code.
- **Prompt injection** — instructions hidden in READMEs/docs/metadata aimed at
  steering an AI agent (treated as untrusted evidence, never followed).

### Behavioral correlation
- **Cross-file exfiltration** — env/file reads co-located with outbound network,
  plus token-exfil split across separate files.
- **Stage-2 loaders** — code that reads an opaque data blob and `eval`s it.
- **Download → execute** — network content fed straight to an interpreter
  (`curl | sh`, `eval` over a fetched body).
- **Environment harvesting** — whole-`process.env` clones near a network sink.

### Policy engine
Every signal resolves to one verdict:

| Verdict | Meaning |
|---|---|
| 🟢 `safe` | no high- or medium-risk indicators |
| 🟡 `review` | incomplete evidence or a privileged capability needing a human |
| 🔴 `block` | high-severity indicators (prompt injection, credential access, persistence, obfuscation + execution, likely exfiltration) |

---

## Architecture

pkgxray is composed of discrete engines, each doing one job:

```
        INPUT ADAPTERS        npm: · lockfile · folder · evidence JSON
              │
              ▼
     ACQUISITION ENGINE       registry meta · GitHub meta · provenance · OSV
              │
              ▼
      QUARANTINE ENGINE       stage tarball in a private sandbox
              │                (no install scripts, no code execution)
              ▼
   STATIC ANALYSIS ENGINE     credentials · persistence · prompt-injection
   + CORRELATION ENGINE       obfuscation · unicode · dynamic load · cross-file
              │
              ▼
       POLICY ENGINE          cite-the-evidence verdict
              │
              ▼
   ┌──────────┴──────────┐
  SAFE      REVIEW      BLOCK
              │
              ▼
   CLI · JSON · MCP server · browser extension
```

See [`docs/architecture.svg`](docs/architecture.svg) for the rendered diagram.

### Ecosystem

The same core engine drives every surface:

```
                    pkgxray core
                         │
      ┌──────────┬───────┼───────┬──────────┐
     CLI    MCP server  JSON   browser    cache
                         API   extension   server
```

---

## Design principles

- **Never execute untrusted code.** Everything happens via static inspection of
  staged bytes.
- **Report only evidence that can be cited.** Every finding points at a file and
  a reason — no black-box score.
- **Favor explainability over scoring.** A human can always see *why* a verdict
  landed.
- **Minimize false positives.** A scanner that cries wolf gets turned off.
- **Operate offline whenever possible.** The static engine needs no network.
- **Zero runtime dependencies.** Just Node.

---

## Threat model

What pkgxray is built to defend against:

- ✓ Malicious npm packages
- ✓ Compromised maintainer accounts (account-takeover publishes)
- ✓ Typosquatting & dependency confusion
- ✓ Credential / secret theft
- ✓ Malicious lifecycle (`postinstall`) scripts
- ✓ Supply-chain tampering (npm artifact ≠ tagged source)
- ✓ Provenance spoofing
- ✓ AI prompt injection embedded in package docs/metadata

### Known blind spot: post-install network execution

pkgxray reasons about the bytes that ship in the tarball. A package that
downloads and runs its real payload *after* install (`curl | sh`, `eval` over a
fetched body, a child process pulling a second stage) can ship a clean tree.
pkgxray flags the **capability** when its shape is unambiguous (the
`remote-code-load` review signal), but it cannot see code that isn't in the
artifact. Treat post-install network execution as outside the guarantee of any
tarball scan, and pair pkgxray with runtime/install-time sandboxing when that
risk matters.

---

## Why false positives matter

A supply-chain scanner is only useful if engineers trust its `block`. Validated
against the 47 most-installed npm packages: **0 false blocks**. The design
choices that get there:

- **README isn't code.** README / markdown / `.rst` / `.txt` run only the
  prompt-injection check — Node never executes them, so an illustrative
  `process.env` + `fetch` example in a README isn't read as exfil.
- **Tests are downgraded.** Test / fixture / example / benchmark files downgrade
  to `review`; hardcoded IPs and `eval` are normal there. Two things stay HIGH:
  the env-harvest + network exfil shape, and any file a lifecycle script actually
  runs (so a payload wired through `postinstall` can't hide under `examples/`).
- **Divergence ≠ malware.** npm-vs-GitHub divergence is a `review` signal, not an
  auto-block — it can't distinguish a normal build/minify step from tampering, so
  it flags for a human instead of crying wolf on every package that ships
  compiled output. The file *contents* are still scanned.
- **Dual-use is treated as dual-use.** URL shorteners count only when co-located
  with a capability; only paste / webhook / OAST / tunnel domains flag on their
  own.

---

## Performance

pkgxray is cheap enough to run on every install. The local static analysis is
~25 ms — almost all of `guard`'s wall-clock is network round-trips:

```
  OSV  →  metadata  →  download  →  extract  →  static analysis  →  decision
  └──────────── network latency ───────────┘     (~25 ms)
```

Measured on an Apple M1 (Node 26), cold cache, one `guard` run per package:

| Package | Weekly downloads | `guard` time |
|---|--:|--:|
| `is-number@7.0.0` | ~170M | ~1.3 s |
| `express@4.21.0` | ~110M | ~1.4 s |
| `commander@12.1.0` | ~444M | ~1.5 s |
| `chalk@5.3.0` | ~451M | ~1.5 s |

| Operation | Time |
|---|---|
| Static audit of supplied evidence (`--file`, no network) | ~140 ms (~25 ms scan) |
| `guard` repeat run, warm cache | ≈25% faster than cold |
| `guard` a known-vulnerable package | blocks at the OSV precheck, *before* download |

Point CI at a shared [cache server](#self-hostable-cache-server) to collapse the
repeated GitHub fetches across runners. Numbers vary with network and machine;
treat them as ballpark.

---

## Quick start

```bash
# Guard an npm package before it reaches your machine
pkgxray guard npm:some-package@1.2.3
pkgxray guard npm:some-mcp-server@1.2.3 --format json

# Guard a local extension and promote it only if policy allows
pkgxray guard ./some-local-extension
pkgxray guard ./ext --promote-to ./approved/ext

# Audit a whole project's lockfile (batch OSV query)
pkgxray audit package-lock.json          # also: yarn.lock, pnpm-lock.yaml, package.json
pkgxray audit package-lock.json --deep    # full static/GitHub layer on each blocked dep

# Audit supplied evidence directly
pkgxray --file examples/evidence.json
pkgxray --format json --file examples/evidence.json
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

---

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

---

## Static heuristics & severity policy

Tuned so legitimate packages stay out of `block` while real attacks still land
there. Validated against the 47 most-installed npm packages: **0 false blocks**.

- **block** (HIGH) — prompt-injection text in docs; credential reads near a
  filesystem-read primitive (including paths **assembled from split string
  fragments** — `".s"+"sh"`, `[".s","sh"][0]+…` — which a light de-obfuscation
  pass folds before matching); persistence writes (shell rc / cron / launchagents);
  execution or outbound network plus a hardcoded public IP / shortener / webhook;
  bulk `process.env` harvest in the same file as outbound network (network sinks
  now include `sendBeacon` / `EventSource` / `dns.*` / `dgram` / remote
  `import()` / image-beacon); a **dynamic `require`/`import`** of a computed name
  co-located with a bulk-env harvest; a **stage-2 loader** that reads an opaque
  data blob (`.dat` / `.bin` / `.txt` / `.enc` …) and `eval`s it; **split
  token-exfil** where the env harvest and a known exfil/callback domain live in
  different files.
- **review** (MEDIUM) — install/postinstall/prepare scripts; dynamic
  eval / `new Function` / vm; a **dynamic `require`/`import`** by computed name on
  its own; **bulk `process.env` harvest** on its own (serialization, iteration,
  or whole-env clone via `{...process.env}` / `Object.assign`); a sensitive path
  or domain **assembled from split fragments**; **Trojan Source** bidi-override /
  zero-width Unicode in code; a **geo/locale-gated destructive op** (logic-bomb /
  protestware shape); **download-then-execute** (network content fed straight to
  an interpreter — `curl | sh`, `eval` over a fetched body); clipboard access; a
  lone reference to a high-confidence exfil/callback domain; **npm-vs-GitHub
  divergence**; missing package.json or entrypoint.
- **info** — child_process/fetch/network in isolation. Recorded, does not gate.

`.d.ts`, `.map`, `.min.js`, and `.lock` files are skipped. Tarballs up to 20,000
entries / 256 MB uncompressed are scanned.

---

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

---

## Browser Extension

`browser-extension/` is a Chrome-compatible Manifest V3 unpacked extension. It
runs entirely locally and requests no browser permissions. Load it via
`chrome://extensions` → enable Developer Mode → **Load unpacked** → select the
`browser-extension/` folder. (In Dia, try the same flow if it supports unpacked
Chromium extensions; otherwise use Chrome.)

---

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

---

## Repository layout

```
src/                 analysis engines (auditor, diff, github, lockfile,
                     quarantine, attestation, triage, cache-client)
bin/                 CLI entrypoints (audit, mcp-server, pkgxray-cache)
browser-extension/   Manifest V3 unpacked extension
docs/                architecture diagram
examples/            sample evidence JSON
scripts/             browser-extension build + popular-package FP harness
test/                node --test suites + fixtures
```

## Local development

```bash
npm run build:browser
npm test
npm run audit:evidence -- --file examples/evidence.json
```
