<div align="center">

# pkgxray

**Supply-chain security for AI agents, npm packages, and Model Context Protocol (MCP) servers.**

Analyze packages *before* you install them. Zero-dependency Node, runs
entirely on your machine, never executes untrusted code.

[![npm version](https://img.shields.io/npm/v/pkgxray)](https://www.npmjs.com/package/pkgxray)
[![tests](https://github.com/adamsjack711-ux/pkgxray/actions/workflows/pkgxray-test.yml/badge.svg)](https://github.com/adamsjack711-ux/pkgxray/actions/workflows/pkgxray-test.yml)
[![calibration benchmark](https://github.com/adamsjack711-ux/pkgxray/actions/workflows/pkgxray-benchmark.yml/badge.svg)](https://github.com/adamsjack711-ux/pkgxray/actions/workflows/pkgxray-benchmark.yml)
[![license: MIT](https://img.shields.io/npm/l/pkgxray)](LICENSE)

**Static analysis** · **Supply-chain intelligence** · **Prompt-injection detection** ·
**MCP security** · **Zero dependencies** · **Evidence-based verdicts** · `SAFE` / `REVIEW` / `BLOCK`

<img src="docs/banner.png" alt="pkgxray — a package under an x-ray scan beam next to the SAFE / REVIEW / BLOCK verdict chips" width="820">

</div>

## 🚀 Quick start

```bash
npm install -g pkgxray        # or zero-install: npx pkgxray …

pkgxray guard npm:express@4.21.0
```

```text
Decision: **SAFE**

Verdict: **SAFE**
Grade: **A+** (99/100)

No high- or medium-risk indicators were found in the provided evidence.

Notes:
- **INFO npm-vs-github-clean** — npm tarball matches the linked GitHub repo
  at the published version. (15/16 files match GitHub @4.21.0)

Parameter grades:
- `knownVulnerabilities`: A+ (100/100)   - `provenance`: A+ (100/100)
- `dataAccess`: A+ (100/100)             - `persistence`: A+ (100/100)
- `obfuscation`: A+ (100/100)            - `injectionResistance`: A+ (100/100)
…
```

<sub>Real output, abridged. A `BLOCK` verdict instead lists every finding with
the file and evidence that produced it.</sub>

Point it at a package, get a `SAFE` / `REVIEW` / `BLOCK` verdict with cited
evidence — before a single line of that package runs. The guard flow stages
the package in a sandboxed quarantine, audits the staged copy, and only
promotes it when policy allows. It never runs `npm install`, lifecycle
scripts, build steps, or package code.

<img src="docs/screenshots/cli-guard-block.png" alt="pkgxray guard blocking a malicious sample: BLOCK verdict, grade F, HIGH credential-access finding citing a wallet read exfiltrated to an attacker endpoint, exit code 2" width="820">

<sub>`guard` blocking a malicious sample from the [calibration corpus](benchmark/)
(modeled on the 2024 `@solana/web3.js` compromise) — the HIGH finding cites the
exact wallet-read + exfiltration code. Real run; see
[how each screenshot was made](docs/screenshots/README.md).</sub>

## 🔒 Why pkgxray?

AI coding assistants increasingly install packages automatically, often
without a human ever reading the code. Traditional antivirus inspects what
*executes*; **pkgxray inspects what gets *installed***.

Vulnerability scanners like `npm audit` and OSV-Scanner answer an essential
question — *does this package have a known CVE?* — and pkgxray asks it too
(via OSV, before anything downloads). But a freshly trojaned package has no
CVE yet. So pkgxray also analyzes **trust**:

- What does the code actually *do* — read credentials? persist? phone home?
- Does the published npm artifact match the tagged GitHub source?
- Is the provenance attestation consistent with the claimed repository?
- Is there a prompt-injection payload aimed at the AI agent reading the docs?

It is intentionally conservative: it only reports evidence it can cite, its
verdicts come from deterministic heuristics (no LLM in the verdict path, so
injected text can't steer them), and its zero-false-block calibration is
[regression-gated in CI](docs/benchmark.md).

> [!NOTE]
> pkgxray is designed to run *alongside* `npm audit` and OSV-Scanner, not
> replace them. See the [comparison table](#-comparison) below.

## ⭐ Key features

### Supply-chain intelligence

- **Known-CVE pre-check** — batch OSV query that blocks *before* download
- **Provenance verification** — sigstore / SLSA attestations, cross-checked
  against the claimed repository
- **Artifact divergence** — the published npm tarball diffed against the
  tagged GitHub source
- **Registry metadata signals** — nonexistent or mismatched repos,
  attestation/repo inconsistencies (typosquat and impersonation indicators)
- **Continuous monitoring** — [`pkgxray recheck`](docs/reference.md#monitoring-pkgxray-recheck)
  diffs installed deps against a stored verdict baseline and pre-vets newer
  versions, catching the maintainer-takeover / trojaned-update case

### Static behavior analysis

- **Credential & secret access** — `.ssh`, `.aws`, `.npmrc`, `.env`,
  keychains, wallets — including paths assembled from split fragments
  (`".s"+"sh"`)
- **Persistence** — writes to shell rc files, cron, launch agents
- **Obfuscation + execution** — a packed blob decoded into `eval` /
  `new Function` / `vm`
- **Behavioral correlation** — cross-file exfiltration, stage-2 loaders,
  download→execute (`curl | sh`), `process.env` harvesting near a network
  sink, on-chain command channels (EtherHiding), hidden self-`node -e`
- **Trojan Source** — bidi / zero-width Unicode attacks
- **Opt-in behavioral canary** — [`pkgxray canary`](docs/canary-threat-model.md)
  executes a package's lifecycle scripts in an OS sandbox with decoy
  credentials. It can *confirm* malice; by design it never *clears* a package.

### Prompt-injection detection

- **Tiered detection** in docs, code comments, and `package.json` metadata
- **Delivery-envelope matching** — instructions smuggled in invisible Unicode
  tag characters ("ASCII smuggling") or base64-encoded in docs/comments.
  Detecting the *envelope*, not the wording, generalizes past rewording.
- **Injection-proof by construction** — verdicts are deterministic; no model
  reads the package, so injected text can't steer the scanner. Full stance:
  [threat model — on prompt injection](docs/threat-model.md#on-prompt-injection).

### MCP security

- **MCP server** — `pkgxray-mcp` gives any MCP-capable agent four audit tools
- **Connect-time vetting** — `pkgxray mcp` performs a read-only handshake and
  audits the tool manifest: injection in tool descriptions, concealed
  envelopes, and **capability-surface mismatch** (a `get_weather` that also
  takes a `command`)
- **Pin & recheck** — `--pin` fingerprints an approved manifest;
  `--recheck` catches the rug-pull

### Runtime protection

- **Per-call gate** — [`pkgxray mcp-proxy`](docs/mcp.md#per-call-runtime-gate-pkgxray-mcp-proxy)
  wraps a live MCP server on the wire: denied tools stripped from listings,
  ~0.05 µs per-call verdict lookup, immediate re-audit on manifest change,
  injection scan of tool *results*, drift-after-pin denial
- **Install gate** — a [hookshot](https://github.com/CorridorSecurity/hookshot)
  hook binary intercepts an agent's shell command and runs `pkgxray guard` on
  every package about to be installed, across Claude Code, Cursor, Windsurf
  Cascade, Factory Droid, and OpenAI Codex
  ([`examples/hookshot/`](examples/hookshot/))

### Policy engine

- **One policy file, every surface** — the CLI, MCP server, and proxy read the
  same `.pkgxray.json` through the same loader; policy can't drift
- **Tighten freely, loosen loudly** — stricter without limit; every loosening
  is explicit and printed in the report
- **Enforced invariants** — an `allow` must be pinned to `name@version` +
  `sha256`; a published CVE can never be muted or allowed away
- **Fail closed** — zero config means maximum strictness; a scan that errors
  becomes `review`, never `safe`

## 🏗️ Architecture

<img src="docs/architecture.svg" alt="pkgxray architecture: inputs flow through the acquisition, quarantine, static-analysis and policy engines to a SAFE / REVIEW / BLOCK verdict" width="820">

<!-- Architecture diagram -->

Acquisition (OSV pre-check → fetch) → sandboxed quarantine → static analysis →
policy → verdict. The same engine backs every surface: CLI, MCP server,
runtime proxy, install hook, browser extension, and CI cache server.

**Design principles:** never execute untrusted code · report only citable
evidence · explainability over black-box scoring · minimize false positives ·
operate offline whenever possible · zero runtime dependencies.

Details: [docs/architecture.md](docs/architecture.md) ·
[docs/design.md](docs/design.md)

## 🚦 Verdicts

Every signal resolves to one of three verdicts:

| Verdict | Meaning | You should |
|---|---|---|
| 🟢 `SAFE` | No high- or medium-risk indicators. | Install. (Only `safe` promotes out of quarantine by default.) |
| 🟡 `REVIEW` | Incomplete evidence, or a privileged capability that needs a human — install scripts, computed `eval`, a lone callback domain, npm↔GitHub divergence. | Inspect the quarantined copy before promoting. `--policy allow-review` promotes review-grade if you accept that. |
| 🔴 `BLOCK` | High-severity, cited evidence — prompt injection, credential access, persistence, obfuscation + execution, likely exfiltration, or a known CVE. | Do not install. Every finding names the file and evidence. |

Exit codes are stable and CI-friendly: **`0`** safe/allow · **`2`** block ·
**`3`** review. The exact mapping of every signal to `block` / `review` /
`info` is specified in the [severity policy](docs/reference.md#severity-policy-what-lands-in-block--review--info).

## 👥 Who is this for?

- **AI developers** — building agents that install packages or connect to MCP
  servers
- **Security engineers** — vetting third-party code with citable evidence
- **DevSecOps** — enforcing supply-chain policy in CI with stable exit codes
  and additive-only JSON
- **Open-source maintainers** — verifying their own dependency trees and
  release provenance
- **Organizations adopting AI coding assistants** — putting a deterministic
  gate between the agent and the registry

## 🧰 Use cases

### Vet an npm package before installing

```bash
pkgxray guard npm:some-package@1.2.3
pkgxray guard npm:some-package@1.2.3 --format json

# Guard a local extension and promote it only if policy allows
pkgxray guard ./ext --promote-to ./approved/ext
```

### Vet an MCP server before connecting

```bash
# Static package scan FIRST, then read-only manifest audit
pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server

pkgxray mcp https://mcp.example.com/mcp     # HTTP server
pkgxray mcp --pin --package npm:some-mcp-server@1.4.2 npx some-mcp-server
pkgxray mcp --recheck npx some-mcp-server   # catch the rug-pull
```

Full MCP guide (server, adapter, runtime proxy): [docs/mcp.md](docs/mcp.md)

### Enforce in CI/CD

```bash
pkgxray audit package-lock.json           # also: yarn.lock, pnpm-lock.yaml, package.json
pkgxray audit package-lock.json --deep    # full static/GitHub layer on each blocked dep

# Scheduled: has anything I already depend on become unsafe since install?
npx pkgxray recheck package-lock.json --format json
```

`recheck` exits non-zero only on a *regression* (a dep whose verdict got
worse), which makes it a clean scheduled job — a ready-made GitHub Actions
workflow is in the [reference](docs/reference.md#monitoring-pkgxray-recheck).
Point `PKGXRAY_CACHE_URL` at the
[self-hostable cache server](docs/reference.md#self-hostable-cache-server) to
collapse duplicate fetches across runners.

### Guard AI coding agents

```json
{ "mcpServers": { "pkgxray": { "command": "pkgxray-mcp" } } }
```

Give the agent the audit tools directly (above), gate its installs with the
[hookshot integration](examples/hookshot/), and wrap its MCP servers with
[`pkgxray mcp-proxy`](docs/mcp.md#per-call-runtime-gate-pkgxray-mcp-proxy).

### Security reviews

```bash
pkgxray --file examples/evidence.json --format json   # audit supplied evidence
```

Every verdict is a structured, citable report (`schemaVersion: 1`,
additive-only — [schema](docs/json-schema.md)), and the quarantined copy is
left on disk for manual inspection on `review`.

## ⚙️ Configuration

One optional `.pkgxray.json`, read by every surface. Zero config is fully
safe — an absent file means maximum strictness.

```jsonc
{
  "policy": "safe-only",              // or "allow-review" (a loosening — warns)
  "failOn": "review",                 // CI exit threshold
  "scanErrorPolicy": "fail-closed",   // a scan that errors → review, never safe

  "allow": [
    { "pkg": "left-pad@1.3.0", "sha256": "e0b0…",
      "reason": "reviewed 2026-07", "expires": "2026-10-01" }
  ]
}
```

Precedence, the `mute` / `mcp` blocks, and the enforced invariants:
[docs/configuration.md](docs/configuration.md) ·
[`.pkgxray.example.json`](.pkgxray.example.json)

## 📸 Screenshots

All captures are real runs — reproduction steps for each are in
[`docs/screenshots/`](docs/screenshots/README.md).

**CLI — `pkgxray guard` clearing `express`, with the npm↔GitHub cross-check**

<img src="docs/screenshots/cli-guard-safe.png" alt="pkgxray guard on express@4.21.0: SAFE verdict, grade A+, npm tarball matches the linked GitHub repo, per-parameter grades" width="820">

**MCP proxy — a live session against a malicious demo server**

<img src="docs/screenshots/mcp-proxy.png" alt="pkgxray mcp-proxy stripping two tools from tools/list (capability mismatch and injection in the description) and denying a tools/call with an isError result" width="820">

<sub>Two tools stripped at `tools/list` — one for capability-surface mismatch,
one for injection in its description; the denied `tools/call` never reaches the
server.</sub>

**hookshot install gate — an agent's `npm install` denied with cited evidence**

<img src="docs/screenshots/hookshot.png" alt="the hookshot guard hook answering a Claude Code PreToolUse event for npm install lodash@4.17.11 with permissionDecision deny and pkgxray's cited known-vulnerability evidence" width="820">

**Browser extension — the local MV3 popup blocking a risky sample**

<img src="docs/screenshots/browser-extension.png" alt="the Supply Chain Auditor extension popup showing a BLOCK verdict, grade F, per-parameter grades, and HIGH injection-attempt and network-exfil-or-loader findings" width="640">

## 📊 Comparison

`npm audit` and [OSV-Scanner](https://google.github.io/osv-scanner/) are
excellent at what they target — matching your dependencies against known
vulnerabilities. pkgxray overlaps with them on that layer and adds the layers
they don't attempt:

| Capability | npm audit | OSV-Scanner | pkgxray |
|---|:-:|:-:|:-:|
| Known-CVE lookup | ✅ | ✅ | ✅ (OSV, blocks before download) |
| Lockfile / project scanning | ✅ | ✅ | ✅ |
| Registry signature / provenance verification | ✅ (`npm audit signatures`) | — | ✅ (sigstore/SLSA + repo cross-check) |
| Static analysis of package code behavior | — | — | ✅ |
| Prompt-injection & Unicode-smuggling detection | — | — | ✅ |
| npm ↔ GitHub artifact divergence | — | — | ✅ |
| Pre-install quarantine of a single package | — | — | ✅ |
| Verdict-drift monitoring vs. a stored baseline | — | — | ✅ |
| MCP server vetting & per-call runtime gating | — | — | ✅ |

<sub>Scoped to npm supply-chain vetting; based on each tool's public
documentation at time of writing. OSV-Scanner covers many ecosystems beyond
npm, which pkgxray does not.</sub>

## 🛡️ Threat coverage

| Threat | Coverage | How pkgxray sees it |
|---|:-:|---|
| Credential theft | ✅ | reads of `.ssh` / `.aws` / `.npmrc` / `.env` / keychains / wallets, incl. split-fragment paths |
| Prompt injection | ✅ | tiered detection in docs, comments, metadata; deterministic verdict path can't be steered by injected text |
| Unicode smuggling | ✅ | invisible tag-block characters ("ASCII smuggling") + Trojan Source bidi / zero-width |
| Base64 payloads | ✅ | encoded envelopes in docs/comments; blobs decoded into computed-arg `eval` / `new Function` / `child_process` |
| Persistence | ✅ | writes to shell rc files, cron, launch agents |
| Obfuscation | ✅ | packed blob + computed-arg execution; minification alone is deliberately *not* flagged |
| Known CVEs | ✅ | OSV batch pre-check before download; never mutable by config |
| Trojaned updates / maintainer takeover | ✅ | `recheck` verdict-drift + version-drift monitoring |
| Artifact divergence | ✅ | published npm tarball diffed against the tagged GitHub source |
| Dependency confusion | ◑ | the out-of-band callback beacons confusion payloads use are flagged; registry resolution itself belongs to your package manager |
| Typosquatting | ◑ | surfaced via repo-mismatch (package.json → nonexistent/mismatched repo) and provenance-mismatch signals; no name-similarity heuristic |
| MCP capability abuse | ✅ | capability-surface mismatch in the manifest audit |
| Runtime tool drift | ✅ | `mcp-proxy` re-audits on `tools/list_changed`; pinned-manifest drift is denied |

<sub>✅ detected · ◑ partial / indirect</sub>

> [!IMPORTANT]
> **Known blind spot:** pkgxray reasons about bytes in the tarball. A package
> that downloads its real payload *after* install can ship a clean tree.
> pkgxray flags the *capability* when its shape is unambiguous, but pair it
> with runtime/install-time sandboxing when that risk matters. Full analysis:
> [docs/threat-model.md](docs/threat-model.md).

## ⚡ Performance

- **Local static analysis: ~25 ms.** Almost all of `guard`'s wall-clock is
  network round-trips — a full guard of `express` / `chalk` / `commander` is
  **~1.3–1.5 s** cold-cache (Apple M1, Node 26).
- **Known-vulnerable packages block at the OSV pre-check**, before download.
- **`mcp-proxy` overhead:** ~0.05 µs per `tools/call` decision; a full
  manifest re-audit (~1 ms per 30 tools) runs only when the manifest changes.
- Calibration — precision, recall, and the **0-false-block** gate — is
  measured by a committed benchmark corpus that fails CI when it regresses.

Full numbers: [docs/reference.md#performance](docs/reference.md#performance) ·
methodology: [docs/benchmark.md](docs/benchmark.md)

## 🗺️ Roadmap

- [ ] List the MCP server in the public MCP registries
- [ ] Ship a reusable GitHub Action wrapping `audit` / `recheck`
- [ ] Publish the browser extension to the Chrome Web Store (today it loads
      unpacked)
- [ ] Replay documented known-malicious npm corpora against the engine and
      publish the results
- [ ] A `--report` evidence bundle for one-command false-block / missed-threat
      reports

<!-- Roadmap: additional planned work is tracked in GitHub issues -->

The longer-form plan lives in the [adoption playbook](docs/adoption.md).

## 📖 Documentation

| Doc | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Pipeline, surfaces, design principles, repo layout |
| [docs/threat-model.md](docs/threat-model.md) | Scope, the known blind spot, false-positive philosophy, prompt-injection stance |
| [docs/mcp.md](docs/mcp.md) | MCP server, connect-time vetting, per-call runtime proxy |
| [docs/configuration.md](docs/configuration.md) | `.pkgxray.json` schema, precedence, invariants |
| [docs/reference.md](docs/reference.md) | Severity policy, `recheck` monitoring, performance, JSON output, browser extension, cache server |
| [docs/benchmark.md](docs/benchmark.md) | Calibration benchmark & real-world validation |
| [docs/compatibility.md](docs/compatibility.md) | The 1.0 compatibility contract & stability tiers |
| [docs/json-schema.md](docs/json-schema.md) | Full `--format json` schema |
| [docs/canary-threat-model.md](docs/canary-threat-model.md) | Threat model for the opt-in `canary` surface |
| [docs/design.md](docs/design.md) · [docs/design/](docs/design/) | Design principles & internal working notes |

Start at the [documentation index](docs/README.md).

## 🛠️ Development

```bash
npm test                 # zero-dep node --test suite
npm run benchmark        # calibration corpus: precision/recall + 0-false-block gate
npm run build:browser    # build the MV3 browser extension
npm run audit:evidence -- --file examples/evidence.json
```

The [calibration benchmark](benchmark/) runs a labelled corpus of malicious
and benign fixtures through the real engine and fails on a false block or a
missed detection. Repo layout is described in
[docs/architecture.md](docs/architecture.md#repository-layout).

## 🔐 Security & license

Releases are published to npm with provenance (SLSA attestation), gated on the
test suite, the calibration benchmark, and pkgxray's own supply-chain guard.
To report a vulnerability in pkgxray itself, see [SECURITY.md](SECURITY.md).

[MIT](LICENSE)
