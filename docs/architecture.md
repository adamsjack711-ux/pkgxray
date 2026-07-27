# Architecture

<img src="architecture.svg" alt="pkgxray architecture: inputs flow through the acquisition, quarantine, static-analysis and policy engines to a SAFE / REVIEW / BLOCK verdict" width="820">

<!-- Architecture diagram (refresh) -->

## The pipeline

Every package flows through the same stages, regardless of which surface
invoked the scan:

1. **Acquisition** — resolve the reference (`npm:name@version`, a local
   directory, or supplied evidence), query OSV for known vulnerabilities
   *before* downloading anything, and fetch the tarball plus registry /
   GitHub / provenance metadata.
2. **Quarantine** — stage the package in a private sandboxed directory.
   Nothing is ever installed: no `npm install`, no lifecycle scripts, no build
   steps, no package code.
3. **Static analysis** — run the calibrated heuristics over the staged bytes:
   credential access, persistence, obfuscation + execution, prompt injection,
   concealed/encoded envelopes, cross-file behavioral correlation.
4. **Policy** — apply `.pkgxray.json` (allowlist, mutes, strictness) and
   resolve every finding into one verdict: `SAFE` / `REVIEW` / `BLOCK`, with
   each finding citing the file and evidence that produced it.
5. **Promotion** (guard flow only) — copy the package out of quarantine only
   when the policy allows it.

## One engine, many surfaces

The same analysis engine and the same policy loader back every surface, so a
verdict — and your policy — cannot drift depending on how a package arrived:

| Surface | Entry point |
|---|---|
| CLI | `pkgxray guard` / `audit` / `recheck` / `mcp` / `mcp-proxy` |
| MCP server | `pkgxray-mcp` (stdio, four tools) |
| Runtime proxy | `pkgxray mcp-proxy` wrapping a live MCP server |
| Install hook | the [hookshot](https://github.com/CorridorSecurity/hookshot) guard binary ([`examples/hookshot/`](../examples/hookshot/)) |
| Browser extension | local MV3 unpacked extension ([reference](reference.md#browser-extension)) |
| Cache server | `pkgxray-cache`, a transparent CI-side fetch cache ([reference](reference.md#self-hostable-cache-server)) |

<!-- MCP proxy diagram -->

## Design principles

- **Never execute untrusted code in the default static-analysis path.** Analysis operates on bytes in quarantine.
  (The sole, deliberate exception is the opt-in [`canary`](canary-threat-model.md)
  surface, which is gated behind an explicit flag and carries its own threat
  model.)
- **Report only citable evidence.** Every finding names the file and the
  matched content. No un-attributable scores.
- **Explainability over black-box scoring.** Verdicts come from deterministic
  heuristics you can read, not from a model.
- **Minimize false positives.** A false block costs trust; calibration is
  regression-gated by the [benchmark](benchmark.md).
- **Operate offline whenever possible.** Local static analysis needs no
  network; network layers (OSV, registry, GitHub, provenance) degrade
  gracefully and scan errors [fail closed](configuration.md).
- **Zero runtime dependencies.** Plain Node; nothing to supply-chain-attack in
  the supply-chain scanner.

See [design.md](design.md) for the reasoning behind these, and
[design/](design/) for the internal working notes.

## Repository layout

```
src/                analysis engines
bin/                CLI entrypoints
browser-extension/  MV3 extension
docs/               documentation (this directory)
examples/           sample evidence + hookshot integration
test/               node --test suites
benchmark/          calibration corpus + runner
skills/             agent skill for evidence-based extension auditing
validation/         top-1000 real-world validation run
```
