# Comparison

`npm audit` and [OSV-Scanner](https://google.github.io/osv-scanner/) match
dependencies against known CVEs. That is a different question, and they answer
it well. pkgxray is built to run alongside them rather than replace them, and it
queries OSV itself before anything downloads. The useful comparison is against
tools in the same lane, the ones that also analyze what package code does:

| Capability | Socket.dev | OpenSSF Package Analysis | Cisco MCP Scanner | pkgxray |
|---|:-:|:-:|:-:|:-:|
| Fully local, zero-dependency, no account or cloud upload | — ¹ | ◑ ² | ◑ ³ | ✓ |
| Static behavior analysis of package code | ✓ | ✓ | ✓ | ✓ |
| Sandboxed execution (dynamic analysis) | — | ✓ ⁴ | ◑ (optional Docker) | ◑ (opt-in `canary`) ⁴ |
| npm ↔ GitHub artifact divergence | unknown | — | — | ✓ |
| Verdict decided by fixed rules rather than a model | — ⁵ | ✓ | ◑ ⁵ | ✓ |
| Pre-install gate with a quarantined copy to review | ◑ ⁶ | — | — | ✓ |
| MCP server vetting before connect | — ⁷ | — | ✓ | ✓ |
| Per-call runtime gating of live MCP traffic | — | — | — ⁸ | ✓ (`mcp-proxy`) |
| Verdict-drift monitoring vs. a stored baseline | ✓ (cloud-side) | — | — | ✓ (local `recheck`) |

<!-- MAINTAINER: re-review this table against each competitor's public docs
     every 60–90 days and update the "Last reviewed" date below. -->

<sub>**Last reviewed against public documentation: 2026-07-21**, and reviewed
again every 60 to 90 days. A **—** means the documentation reviewed on that date
described no equivalent capability. We did not test for it. *unknown* means the
documentation does not say either way.<br>
¹ Socket's analysis runs in its cloud. Socket Firewall needs no account, but it
consults Socket's hosted intelligence on every install.
² Open source and self-hostable, but built as a registry-scale analysis
pipeline (Docker/gVisor), not an install-time gate for developers.
³ The YARA analyzer runs locally. The LLM-as-judge and Cisco AI Defense
analyzers need API keys.
⁴ Both run packages in an OS sandbox. pkgxray's opt-in
[`canary`](canary-threat-model.md) runs two phases: the install lifecycle
scripts, and the entry-point import. It uses decoy credentials, and the kernel
confines outbound traffic (`sandbox-exec` on macOS, a `bwrap` and netns
namespace on Linux). That is how it observes the malicious-on-first-`require`
shape, which is pkgxray's stated
[blind spot](threat-model.md#known-blind-spot). It stays ◑ by design, not
because of a gap in confinement: canary is opt-in, and it can only confirm.
It proves that a package is malicious and never clears one. OpenSSF Package
Analysis, by contrast, runs at registry scale and is on by default. For
confinement levels, the `npm run verify:netns` self-test, and the threat model,
see [canary-threat-model.md](canary-threat-model.md#isolation-levels).
⁵ Socket's LLM-based code inspection is a headline feature
(&ldquo;AI-detected potential malware&rdquo;, confirmed by a person). Cisco's
YARA-only mode uses fixed rules. Its LLM analyzer does not.
⁶ Socket Firewall blocks risky packages at install time. It does not stage a
quarantined copy for a person to review.
⁷ Socket's MCP offering exposes its package-scoring API to agents. It does not
check arbitrary MCP servers when you connect to them.
⁸ Cisco MCP Scanner only analyzes, per its docs. It does not proxy or gate
live MCP traffic.</sub>
