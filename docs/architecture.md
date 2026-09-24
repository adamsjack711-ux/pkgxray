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

The surfaces share the static-analysis engine. Node-based integrations use the
shared configuration loader where policy applies; the browser extension accepts
supplied evidence and uses engine defaults without reading project policy.
Acquisition applies guard policy before promotion, so the copied artifact and the
reported decision use the same evaluation.

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
- **No package-manager runtime dependencies.** Node built-ins plus a pinned,
  vendored parser; the parser is still a third-party maintenance and review
  responsibility, not an absence of supply-chain risk.

See [design.md](design.md) for the reasoning behind these, and
[design/](design/) for the internal working notes.

## Repository layout

```
src/                analysis engines, shared HTTP and subprocess limits
bin/                CLI entrypoints
browser-extension/  MV3 extension
docs/               documentation (this directory)
examples/           sample evidence + hookshot integration
test/               node --test suites
benchmark/          calibration corpus + runner
skills/             agent skill for evidence-based extension auditing
validation/         top-1000 real-world validation run
```

## Coverage and resource boundaries

Source collection returns `sourceCoverage` separately from source text. File-count,
byte-budget, and per-file truncation limits produce a cited coverage finding and
prevent promotion through `allow-review`. A pinned artifact allowlist remains an
explicit operator override. Coverage describes collection of supported text files;
it does not assert behavioral support for every language or inspect native binaries.

`http-client.js` bounds registry and OSV requests by total time and response bytes.
`bounded-process.js` bounds archive commands by execution time and captured output.
Both npm and GitHub extraction reject symlinks, hardlinks and special files before
extraction, then verify the extracted tree without following links. Archives that
rely on internal links are also rejected.
The MCP proxy closes sessions on oversized frames and withholds tool results whose
text exceeds its inspection budget, including structured content and embedded text resources.

## Assessment contract

Guard now follows this order:

1. Stage the artifact and inventory its regular files within a bounded traversal.
2. Read the package manifest, prioritize declared runtime targets regardless of
   filename, and follow literal local imports and statically resolved local
   Node subprocess targets within the same read budget.
3. Finish requested vulnerability and direct-dependency checks.
4. Build findings, apply policy once, derive the decision, and then promote.

`src/source-plan.js` separates runtime-file selection from file IO and detection.
It resolves references conservatively and uses bounded syntax facts for subprocess
paths; it is not a complete Node resolver or JavaScript/shell interpreter.
Missing references, inventory/resolution
limits and unsupported binary runtime files are coverage gaps. Conditional paths
can therefore produce REVIEW even when they are not used in a particular environment.

A requested dependency scan must contribute to the final decision. Exact direct
pins are checked; ranges are not replaced with their minimum version. Use a
resolved lockfile for range resolution and transitive coverage. Approving the
parent artifact does not approve unvetted dependencies.

MCP tool-call errors are model-visible text too. The proxy scans decoded string
values in errors and structured results within its existing inspection limits.
This does not extend protection to every MCP notification, image, audio payload,
or cross-call dataflow; those remain separate trust boundaries.


## Enforced installation

`src/install.js` implements `pkgxray install`. It validates a supported npm lockfile, scans and holds every resolved archive, checks receipts, and rewrites a private lockfile to local archive URLs. A clean npm child runs offline with scripts disabled. The installer compares the resulting tree with approved extracted file hashes, rechecks project inputs and policy, and replaces `node_modules` with rollback and a retained backup. See [scope and threat boundaries](enforced-install.md).

## Parser-based sensitive flows

JavaScript flow hints now use a pinned Acorn 8.18.0 parser and a bounded abstract
interpreter (`src/flow-analysis.js`). The engine tracks modeled environment
values, fetched text, lexical bindings, assignment order, branch joins, simple
function arguments, request-stream objects, and literal local CommonJS/ES module
exports. It interprets syntax as data; it never executes target source.

Limits are 1 MiB per file, 8 MiB per analysis graph, 512 modules, 500,000 evaluation
steps and 160 evaluation depth. Loops use two passes and a conservative
zero-iteration join. Cycles, missing local modules, unmodeled executable AST nodes and exhausted budgets emit
`flow-analysis-gap` REVIEW findings, rather than silently treating partial work
as SAFE. Source-inventory completeness is separate from flow-analysis completeness.

Syntax the parser cannot accept (including TypeScript-specific syntax) retains
the bounded lexical fallback and existing independent detectors. Native code,
arbitrary getters/proxies, dynamic module resolution, general interprocedural
side effects and language-specific behavior are not fully modeled. A parsed AST
is not proof of complete semantic coverage. Findings remain REVIEW because
legitimate authentication can export a credential to its intended service.

Class methods, fields and static blocks are inspected. Node TCP/TLS streams,
execFile, reflected/bound calls, Bun environment values, array and Map aliases,
promise callbacks over fetched data, and Function constructor chains are modeled.
Switch analysis joins possible cases and fallthrough paths. Callable branch joins
retain function metadata, and repeated recursive calls with the same abstract
argument signature are summarized. Unsupported effects still require review;
these summaries do not make the interpreter a general JavaScript runtime.
Proxy/getter semantics, class inheritance/constructor effects and string timers
require REVIEW. Python source adds `unsupported-behavior` REVIEW.
These coverage findings cannot be muted or promoted by `allow-review`; an explicit
hash-pinned artifact approval remains an operator override.

Acorn is bundled third-party code with MIT attribution, a recorded upstream
archive integrity hash and a pinned file hash. No npm dependency installation
is needed, but this component must be maintained and reviewed on updates.

## Local execution graph

`src/execution-graph.js` collects syntax facts without executing package code.
It follows literal local imports and modeled Node `spawn`, `spawnSync`, `execFile`,
`execFileSync` and `fork` targets. Aliases, literal concatenation/templates and
`path.join`/`path.resolve` anchored in `__dirname`/`__filename` are supported.
Inherited process cwd is unknown; it is never assumed to be the artifact root.
Resolved targets become runtime files even with unusual extensions or test/build
directory names, and inherit install/lifecycle context from their caller.

A `hidden-local-loader` BLOCK requires both a concealed subprocess edge and
corroborating findings in its specific resolved target. An ordinary detached
worker alone is not enough. Structural string-table obfuscation requires rotation
or flattened control flow together with computed loading; minification alone is
not evidence of packing. Findings cite the caller, target and contributing signals.

Unknown or missing Node targets and exhausted graph budgets produce
`unresolved-runtime-execution` REVIEW, which guard policy cannot mute or promote
through `allow-review`. Limits include 1 MiB per source string, 8 MiB per graph,
512 files, 200,000 syntax visits per file, depth 160, 256 subprocess edges per file,
and 20,000 reachability iterations. String budgets use JavaScript string length,
not encoded byte length. Collection has its own byte limits.

Repository comparison includes runtime minified files. Concealed execution
callers/targets are not dismissed merely because a package declares a build
script; divergence by itself still requires REVIEW, not automatic BLOCK.

See the [2026-09-23 audit](detection-audit-2026-09-23.md) for paired real-file
results, calibration evidence and remaining enforcement boundaries.
