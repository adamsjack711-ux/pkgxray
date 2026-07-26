# pkgxray positioning

Primary phrase: **Inspect what gets installed before it executes.**

Canonical links:

- Website: <https://pkgxray.ca>
- Repository: <https://github.com/adamsjack711-ux/pkgxray>
- npm: <https://www.npmjs.com/package/pkgxray>

## One sentence

pkgxray is a local, zero-runtime-dependency security tool that quarantines and inspects npm packages before installation, vets MCP servers before connection, and returns deterministic `SAFE`, `REVIEW`, or `BLOCK` verdicts with cited evidence.

## Exactly 30 words

pkgxray inspects npm packages and MCP servers before installation or connection, producing deterministic, evidence-cited verdicts through local static analysis, OSV checks, quarantine, provenance cross-checks, and reproducible calibration for safer automation.

## About 100 words

**Inspect what gets installed before it executes.** pkgxray is a zero-runtime-dependency Node.js CLI and MCP server for npm supply-chain and agent security. It stages packages in quarantine, checks OSV before download, analyzes package bytes without running lifecycle scripts or package code, compares the npm artifact with linked GitHub source, and reports deterministic `SAFE`, `REVIEW`, or `BLOCK` verdicts with file-level evidence. It also vets MCP tool manifests before connection and can gate live stdio MCP calls. Its 2026-07-19 calibration recorded 0 heuristic false blocks after calibration on the top-1000 most-downloaded set. That result is scoped—not a promise of total safety or zero false blocks everywhere.

## Channel descriptions

### GitHub description

Inspect npm packages and MCP servers before they execute—local, deterministic supply-chain analysis with quarantine, OSV checks, artifact cross-checks, and cited evidence.

### npm description

Zero-runtime-dependency Node.js CLI and MCP server for pre-install npm supply-chain inspection: OSV pre-checks, quarantine, deterministic static heuristics, npm-to-GitHub artifact comparison, and evidence-cited `SAFE` / `REVIEW` / `BLOCK` verdicts.

### MCP registry description

Give an AI agent tools to inspect npm packages and lockfiles before installation. pkgxray uses deterministic local analysis, OSV checks, quarantine, and cited evidence; the same project also supports package-scan-first MCP server vetting and a stable stdio runtime proxy.

## Audience pitches

### For developers

The package manager normally asks you to trust first and inspect later. pkgxray reverses that order. Run:

```bash
npx pkgxray guard npm:express@4.21.0
```

The package is staged in quarantine; pkgxray checks known vulnerabilities and analyzes its files without running `npm install`, lifecycle scripts, build steps, or package code. You get a stable verdict, exit code, and evidence you can inspect. Use it beside `npm audit`, not instead of it. A later-stage payload downloaded only at runtime can evade tarball-only analysis, so high-risk workloads still need runtime isolation.

### For security engineers

pkgxray adds a deterministic pre-install control to npm and agent workflows. It correlates static conduct signals, checks OSV before download, compares published artifacts with linked source, parses provenance information without treating it as cryptographic proof, and emits citable findings under a shared fail-closed policy. The public 2026-07-19 revalidation is reproducible from committed package/version inputs and recorded 0 heuristic false blocks after calibration on the top-1000 most-downloaded set. That denominator excludes the MCP hunting set, where known over-blocking remains calibration debt. Stable JSON and exit-code contracts support CI enforcement and audit trails.

### For AI-agent builders

Agents can install packages and connect to MCP servers faster than a human can review either. pkgxray gives the agent a deterministic gate that injected text cannot steer: scan a package before installation, inspect an MCP manifest before connection, pin approved tool fingerprints, and deny drifted or blocked stdio calls through `mcp-proxy`. Start by exposing `pkgxray-mcp`:

```json
{ "mcpServers": { "pkgxray": { "command": "pkgxray-mcp" } } }
```

Package-scan-first ordering matters because enumerating a stdio MCP server runs that server under constrained conditions. pkgxray reduces exposure; it does not replace least privilege, sandboxing, or human review.

## Plain-language explanation

An npm package is a box of files that may run with access to your source code, tokens, shell, and home directory. pkgxray opens a quarantined copy of that box and looks for specific, risky evidence before the package is allowed into your project. It also checks whether the version has a published vulnerability and whether the npm contents line up with the linked source repository.

For MCP, pkgxray can inspect what tools a server claims to provide and flag a mismatch—for example, a weather tool that quietly accepts a shell command. It can also watch a live stdio MCP session for tool-list changes and suspicious result text.

This is a risk decision, not a guarantee. `SAFE` means no high- or medium-risk indicator was found in the available evidence. A package can still fetch a later-stage runtime payload after installation, and uncertain or privileged behavior is intentionally routed to `REVIEW`.

## Precise difference from `npm audit` and OSV-Scanner

The tools answer overlapping but different questions and should be used together.

`npm audit` primarily evaluates an npm dependency tree against npm's vulnerability data. It can also verify registry signatures and provenance with `npm audit signatures`. OSV-Scanner matches packages and lockfiles against the OSV vulnerability database across many ecosystems, not only npm. Both are strongest when a vulnerability or malicious version is already known and represented in advisory data.

pkgxray also performs an OSV pre-check, but its distinguishing question is: **what risk evidence is present in the package being considered right now, before its code runs?** It stages a single npm package in quarantine, statically analyzes package bytes for conduct and prompt-injection signals, compares the npm artifact with linked GitHub source, evaluates provenance consistency without claiming full cryptographic attestation verification, and supports verdict-drift monitoring plus MCP manifest and runtime controls.

That additional scope does not make pkgxray a replacement for either tool:

- OSV-Scanner supports ecosystems pkgxray does not.
- `npm audit` is native to npm dependency remediation and has registry-signature capabilities.
- pkgxray's heuristic verdicts can over-flag; the 0 figure means **0 heuristic false blocks after calibration on the 2026-07-19 top-1000 most-downloaded set only**.
- A clean tarball can download a later-stage payload at runtime. pkgxray may flag an unambiguous loader capability, but tarball inspection cannot see bytes that are not there.

## Evidence and claim boundaries

- **Reproducibility:** the 2026-07-19 top-1000 names and pinned versions are committed under `validation/calibration-2026-07-19/`; the public methodology and aggregate results are linked from <https://pkgxray.ca>.
- **False-block claim:** 0 heuristic false blocks after calibration on the 2026-07-19 top-1000 most-downloaded packages. It is not a whole-registry claim. Three blocks in that set were correct known-CVE blocks, not heuristic false positives.
- **MCP limitation:** a separate 300-package MCP hunting set was outside that denominator and exposed known heuristic over-blocking. Do not extend the top-1000 claim to MCP packages.
- **Recall evidence:** known-malware benchmark samples are reconstructed from public advisories and are **advisory-modeled fixtures, not live malware**. npm removes confirmed malware, so live-registry recall is not claimed.
- **Runtime blind spot:** a package can ship a clean tarball and fetch its real payload later. Pair pre-install analysis with least privilege and runtime sandboxing where the risk warrants it.
- **No total-safety claim:** `SAFE` describes the inspected evidence and policy result; it does not prove a package harmless.

## Product maturity

### Stable

The 1.x compatibility contract covers `guard`, lockfile and file audit, `recheck`, schema-versioned JSON, `.pkgxray.json`, stable exit codes, the four `pkgxray-mcp` tools, connect-time `pkgxray mcp`, stdio `mcp-proxy`, and the optional cache-server interface.

### Experimental

The load-unpacked browser extension and hookshot install-gate integration work today, but their contracts may change or be removed without a major pkgxray version bump.

### Supported, opt-in canary

`pkgxray canary` is the one surface designed to execute untrusted lifecycle scripts. It requires explicit opt-in, should run only on a disposable host, and can confirm observed malicious behavior but can never clear a package. A quiet result is `not-observed`, not `safe`.
