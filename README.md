<div align="center">

# pkgxray

**Analyze packages before you install them.**

Local supply-chain security for AI agents & npm packages.
Zero-dependency Node, runs entirely on your machine, never executes untrusted code.

<img src="docs/architecture.svg" alt="pkgxray architecture: inputs flow through the acquisition, quarantine, static-analysis and policy engines to a SAFE / REVIEW / BLOCK verdict" width="820">

</div>

```bash
npm install -g pkgxray

pkgxray guard npm:some-package@1.2.3
```

Point it at a package, get a `SAFE` / `REVIEW` / `BLOCK` verdict with cited
evidence — before a single line of that package runs.

---

## Why pkgxray exists

AI coding assistants increasingly install packages automatically, often without
a human ever reading the code. Traditional antivirus inspects what *executes*;
**pkgxray inspects what gets *installed*** — evidence-based static analysis on a
package's metadata, source, provenance, and published artifact before it reaches
your machine.

It's intentionally conservative: it only reports evidence it can cite, and
stages everything in a sandboxed quarantine that never runs install scripts or
package code. Triage takes ~1 s/package with no execution risk.

---

## Detection Engine

**Supply-chain intelligence** — known CVEs (OSV, blocks *before* download),
sigstore/SLSA provenance, npm↔GitHub artifact divergence, registry metadata.

**Static code analysis** — credential/secret access (`.ssh`, `.aws`, `.npmrc`,
`.env`, keychains, wallets), persistence writes (shell rc, cron, launch agents),
obfuscation + execution (a packed blob decoded into `eval`/`new Function`/`vm`,
split-string paths), Trojan Source (bidi/zero-width Unicode), and **tiered
prompt-injection** detection in docs, *code comments*, and *`package.json`
metadata* (`description`/`keywords`/`author`) — reworded steering, chat/role
scaffolding (`<|im_start|>`, `<<SYS>>`, `[INST]`), and identity reassignment, not
just verbatim phrases.

**Concealment & encoding** — injection is unsolvable by matching the attacker's
*wording* (paraphrase defeats it), but it has to be *delivered*, and the
delivery tells are high-signal and low-FP. pkgxray detects instructions
**smuggled in invisible characters** (the Unicode tag block — "ASCII smuggling")
and **base64-encoded prompts** hidden in docs/comments that a human can't read
but an agent decodes. It detects the envelope, not the message — so it
generalizes past rewording. (Emoji subdivision flags and benign/binary base64
are excluded.) See [solving prompt injection](#on-prompt-injection).

**Behavioral correlation** — cross-file exfiltration, stage-2 loaders, download→
execute (`curl | sh`), `process.env` harvesting near a network sink.

Every signal resolves to one verdict:

| Verdict | Meaning |
|---|---|
| 🟢 `safe` | no high- or medium-risk indicators |
| 🟡 `review` | incomplete evidence or a privileged capability needing a human |
| 🔴 `block` | high-severity (prompt injection, credential access, persistence, obfuscation + execution, likely exfiltration) |

---

## Architecture

```
   INPUT ADAPTERS        npm: · lockfile · folder · evidence JSON
         │
   ACQUISITION ENGINE    registry meta · GitHub meta · provenance · OSV
         │
   QUARANTINE ENGINE     stage tarball in a private sandbox (no exec)
         │
   STATIC ANALYSIS       credentials · persistence · prompt-injection
   + CORRELATION         obfuscation · unicode · dynamic load · cross-file
         │
   POLICY ENGINE   →   SAFE · REVIEW · BLOCK
         │
   CLI · JSON · MCP server · browser extension
```

**Design principles:** never execute untrusted code · report only citable
evidence · explainability over black-box scoring · minimize false positives ·
operate offline whenever possible · zero runtime dependencies.

---

## Threat model

Malicious npm packages · compromised maintainer accounts · typosquatting &
dependency confusion · credential theft · malicious lifecycle scripts ·
supply-chain tampering (npm artifact ≠ tagged source) · provenance spoofing ·
AI prompt injection in package docs.

**Known blind spot:** pkgxray reasons about bytes in the tarball. A package that
downloads and runs its real payload *after* install can ship a clean tree.
pkgxray flags the *capability* when its shape is unambiguous, but pair it with
runtime/install-time sandboxing when that risk matters.

**Why few false positives:** validated against the 47 most-installed npm
packages with **0 false blocks**. READMEs run only the prompt-injection check
(never read as code); test/fixture/example files downgrade to `review`;
npm↔GitHub divergence is `review`, not auto-block (can't tell a build step from
tampering); URL shorteners count only when co-located with a capability. And
**minification is not obfuscation** — `eval`/`new Function` on a *string
literal* (a bundler's `eval-source-map` module wrapper, a `new Function("return
this")` globalThis probe) is recorded as info, not flagged; only `eval` on a
*computed* argument (`eval(atob(blob))`) gates. That keeps heavily-bundled
frontend packages out of the review pile.

### On prompt injection

Prompt injection isn't "solved" by a scanner, and pkgxray doesn't claim to. The
durable defense is *architectural*, and pkgxray's design reflects three honest
layers:

1. **pkgxray is injection-proof by construction.** Its verdict is computed by
   deterministic heuristics, not by an LLM reading the package — so injected text
   *cannot steer a pkgxray verdict*. There is no model in the decision path to
   hijack.
2. **Detection targets the delivery, not the wording.** Matching an attacker's
   phrasing is a treadmill (paraphrase wins). Matching *how injection is
   delivered* — concealed in invisible characters, base64-encoded, hidden in a
   code comment — generalizes past rewording and has near-zero false positives,
   because legitimate package text doesn't smuggle. The tiered phrase matcher
   catches the rest and routes uncertainty to `review`, never a false `block`.
3. **The real fix lives in the consuming agent.** An agent is only harmed by
   injection if it can also act (install, exfiltrate) on what it read — the
   "lethal trifecta." pkgxray's job is to **quarantine and label** the untrusted
   package so the agent's *capability controls*, the actual security boundary,
   can do theirs. pkgxray reduces exposure; it does not replace least-privilege.

---

## Quick start

```bash
# Guard an npm package before it reaches your machine
pkgxray guard npm:some-package@1.2.3
pkgxray guard npm:some-mcp-server@1.2.3 --format json

# Guard a local extension and promote it only if policy allows
pkgxray guard ./ext --promote-to ./approved/ext

# Audit a whole project's lockfile (batch OSV query)
pkgxray audit package-lock.json          # also: yarn.lock, pnpm-lock.yaml, package.json
pkgxray audit package-lock.json --deep    # full static/GitHub layer on each blocked dep

# Audit supplied evidence directly
pkgxray --file examples/evidence.json --format json

# Re-check already-installed deps against *current* intelligence (monitoring)
pkgxray recheck package-lock.json                 # diff verdicts vs. stored baseline
pkgxray recheck package-lock.json --format json   # machine-readable, for CI cron
```

The guard flow stages the extension in a private quarantine, audits the staged
copy, and only promotes it when policy allows — it never runs `npm install`,
lifecycle scripts, build steps, or extension code. For npm references: resolve
metadata → query OSV → block before download if vulnerable → otherwise extract
into quarantine and run the static audit.

Decisions: `allow` (promotion ok), `review` (inspect quarantine first), `block`
(do not install). Only `safe` promotes by default; `--policy allow-review` also
promotes review-grade. Exit codes: `0` safe/allow, `2` block, `3` review.

---

## Monitoring: `pkgxray recheck`

`guard` and `audit` give a point-in-time verdict *at install*. `recheck` answers
the follow-up they can't: **has anything I already depend on become unsafe since
I installed it?** — the maintainer-takeover / trojaned-update case.

It walks a lockfile, re-runs the guard evaluation (OSV / provenance / divergence)
for each pinned `name@version`, and diffs the fresh verdict against the baseline
stored in `.pkgxray.lock` (written by `triage`/`guard`). It reports a **diff, not
a full report**:

- **regressed** — verdict got worse since `checkedAt` (`allow/safe → review/block`).
  The actionable signal: you may already be exposed.
- **improved** — verdict got better (informational).
- **unchanged** — hidden unless `--verbose`.
- **no-baseline** / **unknown** — never-vetted, or the recheck itself errored (its
  stored verdict is left untouched — never a false allow).

```bash
pkgxray recheck package-lock.json              # human diff
pkgxray recheck package-lock.json --verbose    # also list unchanged deps
pkgxray recheck package-lock.json --no-write    # don't update stored baselines
pkgxray recheck package-lock.json --format json # machine-readable diff
```

**Exit codes** key off the worst *regression*, so CI cron jobs consume `recheck`
exactly as they do `guard`: `0` nothing regressed, `2` a dep regressed to
**block**, `3` a dep regressed to **review**. A dep that was `block` at install
and is *still* `block` is **not a new regression** and does not fail the run.
Available newer-version updates never affect the exit code on their own (see
version drift below) unless you pass `--fail-on-available-updates`.

Set `PKGXRAY_CACHE_URL` so a large tree shares `guard`'s warm cache instead of
re-fetching everything cold.

### Version drift — pre-vet newer versions before you upgrade

Alongside verdict drift, `recheck` also asks the registry whether a **newer
version** exists for each dep and guards it, so you see the security verdict
*before* upgrading — the trojaned-update catch:

- **update-available-safe** — a newer version exists and guards clean.
- **update-available-flagged** — a newer version exists but is `review`/`block`.
  Don't blind-upgrade into it.

To keep registry/OSV cost sane, at most two candidates are vetted per dep: the
**latest** published stable version and the **latest within the pinned major**
(an approximation of your install range), when they differ. Prereleases are
skipped unless the pinned version is itself a prerelease.

Version drift is **informational** — an available flagged update you haven't
installed isn't an active exposure, so it never changes the exit code on its
own. Pass `--fail-on-available-updates` to make a flagged update count, or
`--no-version-drift` to skip the registry pass entirely.

### Scheduled CI job (GitHub Actions)

Run `recheck` against the committed lockfile on a schedule; the job fails the
moment a dependency you already ship regresses:

```yaml
# .github/workflows/pkgxray-recheck.yml
name: pkgxray recheck
on:
  schedule:
    - cron: "0 6 * * *"   # daily 06:00 UTC
  workflow_dispatch:
jobs:
  recheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npx pkgxray recheck package-lock.json --format json
        # exit 2 (regressed→block) or 3 (regressed→review) fails the build;
        # commit the updated .pkgxray.lock back if you want the baseline to move.
```

---

## MCP Server

Use the stdio server from any MCP-capable agent:

```json
{ "mcpServers": { "pkgxray": { "command": "pkgxray-mcp" } } }
```

Tools: `audit_agent_extension_supply_chain` (static heuristics on supplied
evidence), `guard_agent_extension_install` (stage + vuln-check + audit a real
package, auto-fetches provenance), `audit_lockfile_supply_chain` (batch OSV scan
a lockfile), `triage_lockfile_supply_chain` (record each flagged dep as
`allow`/`block` into a sibling `.pkgxray.lock`).

---

## Integrations

**hookshot** — a [hookshot](https://github.com/CorridorSecurity/hookshot) hook
binary that guards installs across Claude Code, Cursor, Windsurf Cascade, Factory
Droid, and OpenAI Codex: it intercepts an agent's shell command, runs
`pkgxray guard` on every package about to be installed, and denies on a `BLOCK`
verdict with pkgxray's cited evidence returned to the agent. See
[`examples/hookshot/`](examples/hookshot/).

---

## Reference

<details>
<summary><b>Severity policy</b> (what lands in block / review / info)</summary>

- **block** (HIGH) — verdict-forcing / rule-overriding prompt-injection text (in
  docs *or* a code comment); credential reads near a filesystem-read primitive
  (including paths assembled from split fragments — `".s"+"sh"` — folded by a
  light de-obfuscation pass); persistence writes; execution/outbound-network plus
  a hardcoded public IP / shortener / webhook; bulk `process.env` harvest in the
  same file as outbound network (sinks include `sendBeacon` / `EventSource` /
  `dns.*` / `dgram` / remote `import()`); a dynamic `require`/`import` of a
  computed name co-located with an env harvest; a stage-2 loader that reads an
  opaque blob and `eval`s it; a large encoded blob decoded into a **computed-arg**
  `eval` / `new Function` / `child_process`; split token-exfil across files;
  **concealed/encoded injection** — instructions smuggled in invisible Unicode
  tag characters, or a base64 blob in docs/comments, that decode to a
  verdict-forcing prompt.
- **review** (MEDIUM) — install/postinstall scripts; `eval` / `new Function` /
  vm on a **computed** argument; weaker prompt-injection (reworded steering,
  chat/role scaffolding like `<|im_start|>` / `<<SYS>>` / `[INST]`, identity
  reassignment); a lone dynamic `require`/`import` by computed name; a lone bulk
  `process.env` harvest; a path/domain assembled from split fragments; Trojan
  Source Unicode; **invisible Unicode tag characters** (text-smuggling channel)
  even when they don't decode to a known prompt; a geo/locale-gated destructive
  op; download-then-execute;
  clipboard access; a lone exfil/callback domain; npm↔GitHub divergence; missing
  package.json or entrypoint.
- **info** — child_process/fetch/network in isolation; `eval` / `new Function` on
  a **string literal** (bundler `eval-source-map` wrapper, feature-detection
  probe — the executed text is in the artifact and scanned as code). Recorded,
  does not gate.

`.d.ts`, `.map`, `.min.js`, `.lock` files are skipped. Tarballs up to 20,000
entries / 256 MB uncompressed are scanned.
</details>

<details>
<summary><b>Performance</b></summary>

Local static analysis is ~25 ms; almost all of `guard`'s wall-clock is network
round-trips (registry, OSV, GitHub, provenance). Measured on an Apple M1
(Node 26), cold cache:

| Package | Weekly downloads | `guard` time |
|---|--:|--:|
| `is-number@7.0.0` | ~170M | ~1.3 s |
| `express@4.21.0` | ~110M | ~1.4 s |
| `commander@12.1.0` | ~444M | ~1.5 s |
| `chalk@5.3.0` | ~451M | ~1.5 s |

A known-vulnerable package blocks at the OSV precheck, before download. Point CI
at the cache server to collapse repeated GitHub fetches across runners.
</details>

<details>
<summary><b>JSON output</b></summary>

All JSON carries `schemaVersion: 1`; within `0.x` fields are additive only. Run
any command with `--format json`. Top-level fields:

- **audit / `--file`** — `verdict`, `grade`, `score`, `parameters`, `summary`,
  `riskBands[]`, `findings[]`
- **guard** — `decision`, `resolved`, `githubMetadata`, `npmVsGithubDiff`,
  `vulnerabilityPrecheck`, `timings`, `quarantinePath`, `promotedPath`, `report`
- **audit `<lockfile>`** — `file`, `format`, `totalDeps`, `uniqueDeps`,
  `summary`, `worstDecision`, `results[]`
</details>

<details>
<summary><b>Browser extension</b></summary>

`browser-extension/` is a Chrome-compatible Manifest V3 unpacked extension that
runs entirely locally and requests no browser permissions. Load it via
`chrome://extensions` → Developer Mode → **Load unpacked** → select the folder.
</details>

<details>
<summary><b>Self-hostable cache server</b></summary>

Every `guard` / `audit --deep` fetches GitHub metadata and tarballs; in CI that
duplicates traffic. Run a shared cache to collapse it into one fetch per
(repo, ref) per TTL window:

```bash
pkgxray-cache --port 8819 --cache-dir /var/cache/pkgxray
export PKGXRAY_CACHE_URL=http://cache.internal:8819
```

Routes: `GET /github/repos/{owner}/{repo}` (1h), `GET
/github/tarball/{owner}/{repo}/{ref}` (24h, streamed), `GET /healthz`. With
`PKGXRAY_CACHE_URL` unset, clients run the default path with zero overhead.

> **Trust model:** the cache is a transparent proxy, **not** an auth boundary —
> no login or rate limit. Run it on a private network or behind a reverse proxy
> that enforces your own auth. Never put it on a public network.
</details>

---

## Development

```bash
npm test
npm run build:browser
npm run audit:evidence -- --file examples/evidence.json
```

```
src/   analysis engines   bin/   CLI entrypoints   browser-extension/   MV3 ext
docs/  architecture        examples/  sample evidence   test/  node --test suites
```
