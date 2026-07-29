# Comparison

`npm audit` and [OSV-Scanner](https://google.github.io/osv-scanner/) match
dependencies against known CVEs — a different question, answered well.
pkgxray is designed to run *alongside* them, not replace them (it queries OSV
itself, before anything downloads). The comparison that matters is against
tools in the same lane — behavioral supply-chain vetting:

| Capability | Socket.dev | OpenSSF Package Analysis | Cisco MCP Scanner | pkgxray |
|---|:-:|:-:|:-:|:-:|
| Fully local, zero-dependency, no account or cloud upload | — ¹ | ◑ ² | ◑ ³ | ✓ |
| Static behavior analysis of package code | ✓ | ✓ | ✓ | ✓ |
| Sandboxed execution (dynamic analysis) | — | ✓ ⁴ | ◑ (optional Docker) | ◑ (opt-in `canary`) ⁴ |
| npm ↔ GitHub artifact divergence | unknown | — | — | ✓ |
| Deterministic verdict path — no LLM an injection can steer | — ⁵ | ✓ | ◑ ⁵ | ✓ |
| Pre-install gate with a quarantined copy to review | ◑ ⁶ | — | — | ✓ |
| MCP server vetting before connect | — ⁷ | — | ✓ | ✓ |
| Per-call runtime gating of live MCP traffic | — | — | — ⁸ | ✓ (`mcp-proxy`) |
| Verdict-drift monitoring vs. a stored baseline | ✓ (cloud-side) | — | — | ✓ (local `recheck`) |

<!-- MAINTAINER: re-review this table against each competitor's public docs
     every 60–90 days and update the "Last reviewed" date below. -->

<sub>**Last reviewed against public documentation: 2026-07-21** (re-reviewed
every 60–90 days). A **—** means no equivalent capability was found in the
public documentation reviewed on that date — not that it was tested and found
absent; *unknown* means not publicly documented either way.<br>
¹ Socket's analysis runs in its cloud; Socket Firewall needs no account but
consults Socket's hosted intelligence on every install.
² Open source and self-hostable, but built as a registry-scale analysis
pipeline (Docker/gVisor), not an install-time developer gate.
³ The YARA analyzer runs locally; the LLM-as-judge and Cisco AI Defense
analyzers require API keys.
⁴ Both detonate packages in an OS sandbox. pkgxray's opt-in
[`canary`](canary-threat-model.md) runs two phases — install lifecycle
scripts *and* the entry-point import — with decoy credentials behind
kernel-confined egress (`sandbox-exec` on macOS, a `bwrap`+netns namespace on
Linux), so the malicious-on-first-`require` shape that is pkgxray's stated
[blind spot](threat-model.md#known-blind-spot) is observed. Still ◑ by
design, not for a confinement gap: canary is opt-in and *confirm-only* (it
proves malice, never *clears* a package), whereas OpenSSF Package Analysis runs
registry-scale and default-on. Confinement levels, the `npm run verify:netns`
self-test, and threat model:
[canary-threat-model.md](canary-threat-model.md#isolation-levels).
⁵ Socket's LLM-based code inspection is a headline feature
(&ldquo;AI-detected potential malware&rdquo;, human-confirmed); Cisco's YARA-only mode
is deterministic, its LLM analyzer is not.
⁶ Socket Firewall blocks risky packages at install time; it does not stage a
quarantined copy for human review.
⁷ Socket's MCP offering exposes its package-scoring API *to* agents; it does
not vet arbitrary MCP servers at connect time.
⁸ Cisco MCP Scanner is analysis-only per its docs — it does not proxy or gate
live MCP traffic.</sub>
