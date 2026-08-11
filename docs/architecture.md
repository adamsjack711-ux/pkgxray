# Architecture

<img src="architecture.svg" alt="pkgxray architecture: inputs flow through the acquisition, quarantine, static-analysis and policy engines to a SAFE / REVIEW / BLOCK verdict" width="820">

<!-- Architecture diagram (refresh) -->

## The pipeline

Every package flows through the same stages, regardless of which surface
invoked the scan:

1. **Acquisition.** Resolve the reference: `npm:name@version`, a local
   directory, or supplied evidence. Query OSV for known vulnerabilities *before*
   downloading anything, then fetch the tarball along with the registry, GitHub,
   and provenance metadata.
2. **Quarantine.** Stage the package in a private sandboxed directory. Nothing
   is ever installed: no `npm install`, no lifecycle scripts, no build steps, no
   package code.
3. **Static analysis.** Run the calibrated heuristics over the staged bytes.
   They cover credential access, persistence, obfuscation plus execution, prompt
   injection, concealed and encoded envelopes, and behavioral correlation across
   files.
4. **Policy.** Apply `.pkgxray.json`, which holds the allowlist, mutes, and
   strictness, then resolve every finding into one verdict: `SAFE`, `REVIEW`, or
   `BLOCK`. Each finding cites the file and evidence that produced it.
5. **Promotion** (guard flow only). Copy the package out of quarantine, but only
   when policy allows it.

## One engine, many surfaces

The same analysis engine and the same policy loader sit behind every surface, so
neither a verdict nor your policy can drift based on how a package arrived:

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

- **Never execute untrusted code in the default static-analysis path.** Analysis
  works on bytes in quarantine. There is one deliberate exception, the opt-in
  [`canary`](canary-threat-model.md) surface, which sits behind an explicit flag
  and carries its own threat model.
- **Report only evidence you can cite.** Every finding names the file and the
  matched content. No scores you cannot trace back.
- **Explain the verdict instead of scoring in a black box.** Verdicts come from
  fixed heuristics you can read, not from a model.
- **Keep false positives low.** A false block costs trust, so the
  [benchmark](benchmark.md) gates calibration against regressions.
- **Work offline where possible.** Local static analysis needs no network. The
  network layers, OSV, registry, GitHub, and provenance, degrade gracefully, and
  scan errors [fail closed](configuration.md).
- **No runtime dependencies.** Plain Node, so there is nothing to
  supply-chain-attack inside the supply-chain scanner.

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
