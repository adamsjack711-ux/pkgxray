<div align="center">

# pkgxray

**Analyze packages before you install them.**

Local supply-chain security for AI agents & npm packages.
Zero-dependency Node, runs entirely on your machine, never executes untrusted code.

<img src="docs/banner.png" alt="pkgxray — a package under an x-ray scan beam next to the SAFE / REVIEW / BLOCK verdict chips" width="820">

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

- **Supply-chain intelligence** — known CVEs (OSV, blocks *before* download),
  sigstore/SLSA provenance, npm↔GitHub artifact divergence, registry metadata.
- **Static code analysis** — credential/secret access (`.ssh`, `.aws`,
  `.npmrc`, `.env`, keychains, wallets), persistence writes (shell rc, cron,
  launch agents), obfuscation + execution (a packed blob decoded into
  `eval`/`new Function`/`vm`), Trojan Source (bidi/zero-width Unicode), and
  tiered prompt-injection detection in docs, code comments, and `package.json`
  metadata.
- **Concealment & encoding** — instructions smuggled in invisible characters
  (the Unicode tag block, "ASCII smuggling") or base64-encoded in docs/comments.
  It detects the *delivery envelope*, not the wording, so it generalizes past
  rewording. See [on prompt injection](#on-prompt-injection).
- **Behavioral correlation** — cross-file exfiltration, stage-2 loaders,
  download→execute (`curl | sh`), `process.env` harvesting near a network sink,
  on-chain command channels (EtherHiding), and hidden self-`node -e` execution.

Every signal resolves to one verdict:

| Verdict | Meaning |
|---|---|
| 🟢 `safe` | no high- or medium-risk indicators |
| 🟡 `review` | incomplete evidence or a privileged capability needing a human |
| 🔴 `block` | high-severity (prompt injection, credential access, persistence, obfuscation + execution, likely exfiltration) |

---

## Architecture

<img src="docs/architecture.svg" alt="pkgxray architecture: inputs flow through the acquisition, quarantine, static-analysis and policy engines to a SAFE / REVIEW / BLOCK verdict" width="820">

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
packages with **0 false blocks**. READMEs run only the prompt-injection check;
test/fixture/example files downgrade to `review`; npm↔GitHub divergence is
`review`, not auto-block; and minification is not obfuscation — only `eval` on a
*computed* argument gates, keeping heavily-bundled frontend packages out of the
review pile.

### On prompt injection

Prompt injection isn't "solved" by a scanner, and pkgxray doesn't claim to. Its
design reflects three honest layers:

1. **Injection-proof by construction.** Verdicts are computed by deterministic
   heuristics, not by an LLM reading the package, so injected text can't steer a
   pkgxray verdict.
2. **Detection targets the delivery, not the wording.** Matching *how* injection
   is delivered — concealed characters, base64, hidden in a comment —
   generalizes past rewording with near-zero false positives; uncertainty routes
   to `review`, never a false `block`.
3. **The real fix lives in the consuming agent.** pkgxray quarantines and labels
   the untrusted package so the agent's capability controls can do their job. It
   reduces exposure; it does not replace least-privilege.

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
```

The guard flow stages the package in a private quarantine, audits the staged
copy, and only promotes it when policy allows — it never runs `npm install`,
lifecycle scripts, build steps, or package code.

Decisions: `allow` (promotion ok), `review` (inspect quarantine first), `block`
(do not install). Only `safe` promotes by default; `--policy allow-review` also
promotes review-grade. Exit codes: `0` safe/allow, `2` block, `3` review.

---

## Configuration: `.pkgxray.json`

Every surface — CLI, MCP server, and proxy — reads **one** optional policy file
through the same loader, so your policy can't drift between them. Zero config is
fully safe: an absent file means maximum strictness.

The governing rule is **tighten freely, loosen loudly** — you may make the policy
stricter without limit; every loosening must be explicit and is printed in the
report. Two rules are enforced in code:

1. **An `allow` entry must be pinned** to `name@version` **and** a `sha256`.
   Un-pinned allows are dropped with a warning.
2. **A published vulnerability can never be muted or allowed away.** OSV
   `known-vulnerability` findings always surface.

```jsonc
{
  "policy": "safe-only",        // or "allow-review" (a loosening — warns)
  "failOn": "review",           // CI exit threshold
  "scanErrorPolicy": "fail-closed",   // a scan that errors → review, never safe

  "allow": [
    { "pkg": "left-pad@1.3.0", "sha256": "e0b0…",
      "reason": "reviewed 2026-07", "expires": "2026-10-01" }
  ],
  "mute": [
    { "check": "lonely-maintainer", "scope": "@myorg/*", "reason": "internal registry" }
  ],

  "mcp": { "tools": ["audit", "recheck"], "packageScanFirst": true, "timeoutMs": 15000 }
}
```

Precedence (lowest → highest): built-in safe defaults → project `.pkgxray.json`
→ local `.pkgxray.local.json` → `PKGXRAY_*` env vars → CLI flags. See
[`.pkgxray.example.json`](.pkgxray.example.json) and [`docs/config.md`](docs/config.md)
for the full schema.

---

## Monitoring: `pkgxray recheck`

`guard` and `audit` give a point-in-time verdict *at install*. `recheck` answers
the follow-up: **has anything I already depend on become unsafe since I
installed it?** — the maintainer-takeover / trojaned-update case.

It walks a lockfile, re-runs the guard evaluation for each pinned `name@version`,
and diffs the fresh verdict against the baseline in `.pkgxray.lock`. It reports a
**diff, not a full report**: *regressed* (verdict got worse — you may be
exposed), *improved*, *unchanged* (hidden unless `--verbose`), and
*no-baseline* / *unknown*.

```bash
pkgxray recheck package-lock.json              # human diff
pkgxray recheck package-lock.json --verbose    # also list unchanged deps
pkgxray recheck package-lock.json --no-write    # don't update stored baselines
pkgxray recheck package-lock.json --format json # machine-readable diff
```

Exit codes key off the worst *regression*: `0` nothing regressed, `2` regressed
to **block**, `3` regressed to **review**. A dep that was already `block` at
install is not a new regression. Set `PKGXRAY_CACHE_URL` so a large tree shares
`guard`'s warm cache.

**Version drift** — `recheck` also asks the registry whether a **newer version**
exists and guards it, so you see the verdict *before* upgrading. This is
informational (never changes the exit code) unless you pass
`--fail-on-available-updates`; `--no-version-drift` skips the registry pass.

### Scheduled CI job (GitHub Actions)

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
        # exit 2 (regressed→block) or 3 (regressed→review) fails the build
```

---

## MCP Server

Use the stdio server from any MCP-capable agent:

```json
{ "mcpServers": { "pkgxray": { "command": "pkgxray-mcp" } } }
```

Tools: `audit_agent_extension_supply_chain` (static heuristics on supplied
evidence), `guard_agent_extension_install` (stage + vuln-check + audit a real
package), `audit_lockfile_supply_chain` (batch OSV scan a lockfile),
`triage_lockfile_supply_chain` (record each flagged dep into `.pkgxray.lock`).

### Vetting MCP servers you connect to: `pkgxray mcp`

An agent pulls untrusted things in two ways — packages it installs, and MCP
servers it connects to. `pkgxray mcp` covers the second: it connects to a server
(stdio or streamable HTTP), performs the read-only handshake, and enumerates the
tool manifest via `tools/list` — never calling a tool, reading a resource, or
invoking a prompt.

```bash
# Vet the server package statically FIRST, then connect and audit the manifest
pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server

pkgxray mcp https://mcp.example.com/mcp                          # an HTTP server
pkgxray mcp --pin --package npm:some-mcp-server@1.4.2 npx some-mcp-server   # approve
pkgxray mcp --recheck npx some-mcp-server                        # catch the rug-pull
```

The manifest audit looks for prompt injection in tool descriptions and the
server's `instructions` blurb, concealed Unicode/base64 envelopes, and one
MCP-specific check — **capability-surface mismatch** (a `get_weather` that also
takes a `command`).

**The one caveat:** everything else pkgxray does is static, but enumerating a
stdio server means spawning and running it. `pkgxray mcp` narrows the risk (an
allowlist-scrubbed environment, a hard timeout, bounded output, its process
group killed after listing), but the safe order is **package-scan first** — pass
`--package <ref>` so the no-execution scan clears the server before anything
connects. `--no-package-scan` skips it explicitly.

### Per-call runtime gate: `pkgxray mcp-proxy`

`pkgxray mcp` is connect-time. Two attacks only exist *inside* a live session: a
manifest that changes after approval (the rug-pull moving in real time) and
poisoned tool **output** steering the model. `mcp-proxy` sits on the wire —
point the host's server config at the proxy and it launches the real server as
its child, relaying every JSON-RPC frame through the gate.

```jsonc
// .mcp.json — wrap the real launcher
{
  "mcpServers": {
    "some-server": {
      "command": "pkgxray",
      "args": ["mcp-proxy", "--", "npx", "some-mcp-server"]
    }
  }
}
```

| Moment | Check | Cost |
|---|---|---|
| first `tools/list` | full static manifest audit; denied tools are **stripped from the listing** | ~1 ms per 30 tools |
| every `tools/call` | in-memory verdict lookup; unknown / blocked tools denied | **~0.05 µs** |
| `tools/list_changed` | immediate re-list + re-audit; mid-verification calls **held**, then decided against the fresh manifest | one manifest audit |
| every `tools/call` result | doc-typed injection scan of the result text, capped at 512 KiB | ~0.06 ms for 2 KB |
| after `--pin` | fresh manifest diffed against pinned fingerprints; **drifted tools denied** until re-approved | one lock-file read |

Policies mirror the hookshot gate: `block` denies everywhere; `review` denies
under `--policy strict`, passes with a warning under `balanced` (default) and
`permissive`. A denied call never reaches the server — the agent gets an
`isError` result naming the reason. HTTP servers aren't wrapped; vet those with
connect-time `pkgxray mcp <url>` + `--pin`/`--recheck`.

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

Detailed reference lives in [`docs/reference.md`](docs/reference.md):

- **[Severity policy](docs/reference.md#severity-policy-what-lands-in-block--review--info)** — exactly what lands in `block` / `review` / `info`.
- **[Performance](docs/reference.md#performance)** — `guard` timings and `mcp-proxy` gate overhead.
- **[JSON output](docs/reference.md#json-output)** — top-level fields per command (full schema: [json-schema.md](docs/json-schema.md)).
- **[Browser extension](docs/reference.md#browser-extension)** — the local MV3 unpacked extension.
- **[Self-hostable cache server](docs/reference.md#self-hostable-cache-server)** — collapse duplicate CI fetches.

Other docs: **[compatibility & stability tiers](docs/compatibility.md)** ·
**[JSON schema](docs/json-schema.md)** · **[configuration schema](docs/config.md)** ·
**[canary threat model](docs/canary-threat-model.md)** · **[design notes](docs/design/)** ·
**[adoption playbook](docs/adoption.md)**.

---

## Development

```bash
npm test                 # zero-dep node --test suite
npm run benchmark        # calibration corpus: precision/recall + 0-false-block gate
npm run build:browser
npm run audit:evidence -- --file examples/evidence.json
```

The [calibration benchmark](benchmark/) runs a labelled corpus of malicious and
benign fixtures through the real engine and fails on a false block or a missed
detection. See [`benchmark/README.md`](benchmark/README.md).

```
src/   analysis engines   bin/   CLI entrypoints   browser-extension/   MV3 ext
docs/  architecture        examples/  sample evidence   test/  node --test suites
benchmark/  calibration corpus + runner
```
