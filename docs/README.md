# pkgxray documentation

The [top-level README](../README.md) is the project homepage — install, quick
start, and a tour of the capabilities. Everything deeper lives here.

## User guides

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | The analysis pipeline, the surfaces that share it, design principles, repo layout |
| [threat-model.md](threat-model.md) | What pkgxray defends against, the known blind spot, false-positive philosophy, the honest position on prompt injection |
| [mcp.md](mcp.md) | The MCP server, connect-time vetting of MCP servers (`pkgxray mcp`), and the per-call runtime gate (`pkgxray mcp-proxy`) |
| [integrations/github-actions.md](integrations/github-actions.md) | Pull-request scans, scheduled rechecks, exact package scans, and the reusable GitHub Actions workflow |
| [configuration.md](configuration.md) | The `.pkgxray.json` policy file — schema, precedence, and the "tighten freely, loosen loudly" invariants |
| [reference.md](reference.md) | Severity policy, `recheck` monitoring, performance numbers, JSON output, browser extension, cache server |
| [benchmark.md](benchmark.md) | The calibration benchmark — how the 0-false-block claim is measured and regression-gated |

## Contracts & policies

| Doc | What it covers |
|---|---|
| [compatibility.md](compatibility.md) | The 1.0 compatibility contract: Stable / Experimental / opt-in surface tiers, versioning policy |
| [json-schema.md](json-schema.md) | The full `--format json` schema (`schemaVersion: 1`, additive-only) |
| [canary-threat-model.md](canary-threat-model.md) | The threat model for `pkgxray canary` — the one opt-in surface that executes code |
| [../SECURITY.md](../SECURITY.md) | Reporting a vulnerability in pkgxray itself |

## Background

| Doc | What it covers |
|---|---|
| [design.md](design.md) | Design principles and the reasoning behind them |
| [design/](design/) | Internal design and triage working notes, kept for provenance |
| [adoption.md](adoption.md) | The playbook for getting pkgxray exercised against real-world traffic |
