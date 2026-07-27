<div align="center">

# pkgxray — pre-install security for npm packages, MCP servers, and AI agents

**Inspect an npm package or MCP server before you install or connect to it, and
get a deterministic, evidence-backed `SAFE`, `REVIEW`, or `BLOCK` verdict.**
Local, zero-dependency static analysis — normal scans never execute package code.

[![npm version](https://img.shields.io/npm/v/pkgxray)](https://www.npmjs.com/package/pkgxray)
[![tests](https://github.com/adamsjack711-ux/pkgxray/actions/workflows/pkgxray-test.yml/badge.svg)](https://github.com/adamsjack711-ux/pkgxray/actions/workflows/pkgxray-test.yml)
[![calibration benchmark](https://github.com/adamsjack711-ux/pkgxray/actions/workflows/pkgxray-benchmark.yml/badge.svg)](https://github.com/adamsjack711-ux/pkgxray/actions/workflows/pkgxray-benchmark.yml)
[![license: MIT](https://img.shields.io/npm/l/pkgxray)](LICENSE)

<img src="docs/demo/hero.gif" alt="pkgxray guard clearing express@4.21.0 with a SAFE A+ verdict, then blocking a trojaned sample with a BLOCK F verdict and a HIGH credential-access finding" width="820">

<sub>Real runs: `guard` clears `express@4.21.0`, then blocks a sample modeled on
the 2024 `@solana/web3.js` compromise.</sub>

</div>

## Why

AI coding assistants install packages and connect to MCP servers at machine
speed, often without a human reading the code. Sonatype identified **more than
454,600 new malicious open-source packages across monitored ecosystems in
2025**, over 99% of them on npm
([Sonatype](https://www.sonatype.com/state-of-the-software-supply-chain/2026/open-source-malware)).
`npm audit` asks *does this have a known CVE?*; pkgxray also asks *what does the
code actually do* — before anything installs.

## Quick start

**1. Scan a known-benign package** (no install of pkgxray needed):

```bash
npx --yes pkgxray@1.0.4 guard npm:express@4.21.0
```

It stages the tarball in quarantine and runs the static and supply-chain checks
— no `npm install`, no lifecycle scripts, no package code executed.

```text
Decision: SAFE   Grade: A+ (99/100)
No high- or medium-risk indicators were found in the provided evidence.
```

**2. Read the verdict:**

| Verdict | Exit | Meaning |
|---|---:|---|
| `SAFE` | `0` | No high- or medium-risk indicators; default policy permits promotion. |
| `REVIEW` | `3` | Evidence is incomplete or a privileged capability needs human review. |
| `BLOCK` | `2` | High-severity cited evidence — reject or investigate. |

`SAFE` is not a proof that a package is harmless; static analysis cannot see a
payload downloaded only at runtime. See the [threat model](docs/threat-model.md).

**3. See a BLOCK on the supplied inert fixture:**

```bash
npx --yes pkgxray@1.0.4 --file examples/onboarding-malicious.json --format markdown
```

The fixture is inert source text modeling a split-string SSH-key read and
exfiltration — **it is never executed**. It returns `BLOCK` (exit `2`) with the
cited file and evidence.

**4. Add it to your workflow** — [rechecks & CI](docs/reference.md#monitoring-pkgxray-recheck),
[MCP](docs/mcp.md#the-pkgxray-mcp-server), [Hookshot install gate](examples/hookshot/).

> **Two execution models.** Default `guard` and `audit` scans are **static** —
> package code is never executed. Enumerating an MCP server may spawn it and
> `mcp-proxy` runs it behind a gate; the opt-in
> [`canary`](docs/canary-threat-model.md) is the one deliberate exception that
> *executes* the package in a sandbox to confirm behavior — it can confirm
> malice but never prove a package safe. Full boundary: [SECURITY.md](SECURITY.md#scope).

## What it catches

Credential theft (incl. split-fragment paths), prompt injection, Unicode
smuggling, base64 payloads and stage-2 loaders, exfiltration, persistence,
obfuscated computed-arg execution, known CVEs (via OSV, before download),
npm↔GitHub artifact divergence, trojaned updates (`recheck`), and MCP
capability-surface abuse. Verdicts come from deterministic heuristics — no LLM
in the verdict path, so injected text can't steer them. Full matrix and the
known download-later blind spot: [docs/threat-model.md](docs/threat-model.md).

## Usage

```bash
pkgxray guard npm:some-package@1.2.3 [--format json]   # vet a package before install
pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server   # vet an MCP server; --recheck catches the rug-pull
pkgxray audit package-lock.json [--deep]               # also: yarn.lock, pnpm-lock.yaml, package.json
pkgxray recheck package-lock.json                      # scheduled: non-zero only on a regression
```

Exit codes are stable and CI-friendly: **`0`** safe/allow · **`2`** block ·
**`3`** review.

## Integrations

One engine behind every entry point. "Works with" means a documented setup
guide, not a vendor-endorsed integration.

| Where | What it does | Guide |
|---|---|---|
| Coding agents — Codex, Claude Code, Cursor, Windsurf | Gate installs and expose the audit tools to the agent | [coding-agents.md](docs/integrations/coding-agents.md) |
| MCP clients | Vet a server before connect; run pkgxray itself as an MCP server | [mcp.md](docs/mcp.md) |
| GitHub Actions / CI | Fail a build when a dependency crosses policy | [github-actions.md](docs/integrations/github-actions.md) |
| Install gate — Hookshot | Run `guard` on every package an agent tries to install | [examples/hookshot/](examples/hookshot/) |
| Runtime MCP gate | Proxy a live MCP server and gate every tool call | [`mcp-proxy`](docs/mcp.md#per-call-runtime-gate-pkgxray-mcp-proxy) |
| Dependency monitoring | Re-vet installed deps and pre-vet upgrades on a schedule | [`recheck`](docs/reference.md#monitoring-pkgxray-recheck) |

## Configuration

One optional `.pkgxray.json`, read by every surface; zero config means maximum
strictness. CVEs can never be allowed away, every loosening is printed, and a
scan that errors fails closed to `review`. Schema and invariants:
[docs/configuration.md](docs/configuration.md) ·
[`.pkgxray.example.json`](.pkgxray.example.json).

## Evidence

The **zero-heuristic-false-block calibration on the top-1000 most-downloaded
packages** is regression-gated in CI ([scope & methodology](docs/benchmark.md)),
and the published calibration runs live at <https://pkgxray.ca/stats>. That claim
is scoped to the most-installed set — not a claim of zero false blocks on every
package.

## How it compares

Run pkgxray *alongside* `npm audit` / OSV-Scanner, not instead of them. The
full behavioral-vetting comparison (Socket.dev, OpenSSF Package Analysis, Cisco
MCP Scanner) is in [docs/comparison.md](docs/comparison.md).

## Documentation

| Doc | What it covers |
|---|---|
| [architecture.md](docs/architecture.md) · [design.md](docs/design.md) | Pipeline, surfaces, principles |
| [threat-model.md](docs/threat-model.md) | Scope, blind spots, prompt-injection stance |
| [mcp.md](docs/mcp.md) · [mcp-registry.md](docs/mcp-registry.md) | MCP vetting, runtime proxy, registry entry |
| [canary-threat-model.md](docs/canary-threat-model.md) | The opt-in behavioral canary |
| [configuration.md](docs/configuration.md) · [reference.md](docs/reference.md) | `.pkgxray.json`, severity policy, `recheck`, cache server |
| [benchmark.md](docs/benchmark.md) · [comparison.md](docs/comparison.md) | Calibration and how it compares |
| [compatibility.md](docs/compatibility.md) · [json-schema.md](docs/json-schema.md) | 1.0 contract, `--format json` schema |

Start at the [documentation index](docs/README.md).

## Development

```bash
npm test                 # zero-dep node --test suite
npm run benchmark        # calibration corpus: precision/recall + 0-false-block gate
npm run validate:website # regenerate + validate the calibration pages
```

Contributions welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities per
[SECURITY.md](SECURITY.md). Releases publish to npm with provenance, gated on
tests, the calibration benchmark, and pkgxray's own supply-chain guard.

[MIT](LICENSE)
