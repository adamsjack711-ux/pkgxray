# pkgxray launch materials

Primary phrase: **Inspect what gets installed before it executes.**

Use <https://pkgxray.ca> as the primary destination and <https://github.com/adamsjack711-ux/pkgxray> when the audience expects source, methodology, or an issue tracker.

## Shared factual footer

Use or link this wherever space permits:

> pkgxray is not a guarantee of safety. Its 0 figure is strictly 0 heuristic false blocks **after calibration on the 2026-07-19 top-1000 most-downloaded npm packages**—not zero false blocks across npm. A separate 300-package MCP scan showed known over-blocking and is outside that denominator. Recall fixtures are reconstructed from public advisories and advisory-modeled, not live malware. Static tarball analysis may not see a later-stage payload fetched at runtime. Stable: CLI, JSON/exit codes, MCP tools, connect-time vetting, and stdio proxy. Experimental: browser extension and hookshot integration. Canary is supported but opt-in, executes untrusted lifecycle scripts, and can confirm malice but never clear a package.

## Show HN

### Title

Show HN: pkgxray – Inspect npm packages and MCP servers before they execute

### Body

I built pkgxray around a simple ordering change: **inspect what gets installed before it executes.**

It is a zero-runtime-dependency Node.js CLI and MCP server. `guard` fetches an npm package into quarantine, checks OSV before download, statically analyzes the package bytes, compares the npm artifact with linked GitHub source, and returns `SAFE`, `REVIEW`, or `BLOCK` with cited files and evidence. It does not run `npm install`, lifecycle scripts, build steps, or package code.

```bash
npx pkgxray guard npm:express@4.21.0
```

There is also a stable MCP path: agents can call pkgxray as an MCP tool; `pkgxray mcp --package ...` performs package-scan-first server vetting; and `mcp-proxy` gates live stdio calls, tool-list drift, and suspicious tool results.

I wanted the calibration claim to be inspectable rather than promotional. The 2026-07-19 package/version inputs are committed, the command and adjudication method are public, and a full rerun after calibration recorded 0 heuristic false blocks on the top-1000 most-downloaded set. That claim is narrow. A separate 300-package MCP scan exposed known over-blocking and is not in the denominator.

The known-malware corpus uses reconstructed, advisory-modeled fixtures—not live malware. Static inspection also has a hard boundary: a clean tarball can fetch a later-stage payload at runtime. `SAFE` is therefore a verdict on available evidence, not proof of harmlessness.

Website and public calibration: <https://pkgxray.ca>  
Source: <https://github.com/adamsjack711-ux/pkgxray>

I would especially value scrutiny of the severity policy, calibration method, and MCP capability-surface checks.

### First comment

A few implementation details that may answer the first questions:

- The verdict path is deterministic; no LLM reads the package to decide the verdict, so package text cannot prompt the classifier into changing its decision.
- Known vulnerabilities are checked through OSV before package download. They cannot be muted or allowed away.
- npm provenance is parsed and cross-checked, but pkgxray does not claim full local cryptographic verification of sigstore/Fulcio/Rekor under its zero-dependency design.
- The MCP connect-time adapter performs a read-only handshake and `tools/list`. For stdio, listing tools still means spawning the server, so `--package` scans its package first and the child runs with a scrubbed environment, bounded output, and timeout.
- The public 0 result is specifically 0 heuristic false blocks after calibration on the 2026-07-19 top-1000 most-downloaded set. It says nothing universal about `REVIEW`, niche packages, or all future inputs.
- Experimental surfaces are the browser extension and hookshot integration. Canary is separate and opt-in because it deliberately executes lifecycle scripts in an OS sandbox; it can only confirm observed behavior.

Reproduce a single target with:

```bash
pkgxray guard npm:<name>@<version> --format json
```

The pinned target list and methodology are linked from <https://pkgxray.ca/stats>.

## Reddit — r/node

### Title

I built a zero-dependency Node CLI to inspect npm packages before installation

### Post

pkgxray is an npm supply-chain scanner built around one rule: **inspect what gets installed before it executes.**

Try it without a global install:

```bash
npx pkgxray guard npm:express@4.21.0
```

`guard` stages the tarball in quarantine, checks OSV, analyzes package bytes without running package code or lifecycle scripts, compares the published artifact with linked GitHub source, and prints an evidence-cited `SAFE`, `REVIEW`, or `BLOCK` verdict. Stable exit codes are `0`, `3`, and `2`, so it can gate CI or an agent workflow.

This is complementary to `npm audit`: both cover known vulnerabilities, while pkgxray adds pre-install static conduct analysis, artifact comparison, prompt-injection checks, and MCP security. It does not replace npm's native remediation or signature tooling.

The public 2026-07-19 calibration is reproducible from committed package/version inputs. After calibration, the fresh top-1000 most-downloaded set had 0 heuristic false blocks. That is not “zero false positives everywhere”: an independent 300-package MCP scan showed known over-blocking, and `REVIEW` is intentionally common for incomplete or privileged evidence.

Other limits: the malware benchmark uses reconstructed, advisory-modeled fixtures rather than live malware, and a package that fetches a later-stage payload at runtime can look clean in its tarball. Use runtime isolation when that threat matters.

Stable surfaces include the CLI, JSON schema, exit codes, MCP tools, connect-time MCP vetting, and stdio proxy. The browser extension and hookshot integration are experimental; canary is opt-in and executes untrusted scripts only to confirm observed behavior.

<https://pkgxray.ca> · <https://github.com/adamsjack711-ux/pkgxray>

## Reddit — r/cybersecurity

### Title

Open-source pre-install npm and MCP scanner with a reproducible false-block calibration

### Post

pkgxray is a deterministic pre-install control for npm packages and AI-agent/MCP workflows: **inspect what gets installed before it executes.**

The normal path does not execute package code. It performs an OSV pre-check, quarantines the artifact, statically correlates conduct signals, compares npm contents with linked source, checks prompt-injection delivery patterns, and emits file-level evidence under a `SAFE` / `REVIEW` / `BLOCK` policy.

```bash
npx pkgxray guard npm:<package>@<version> --format json
```

For MCP, it supports package-scan-first manifest vetting, pin/recheck of tool fingerprints, and a stable stdio proxy that denies blocked or drifted tools and scans tool results. The deterministic verdict path is not steerable by prompt text, but this is not a substitute for least privilege or host isolation.

The calibration boundary is explicit. A 2026-07-19 rerun over the pinned top-1000 most-downloaded package set recorded 0 heuristic false blocks after calibration; package names, versions, command, and methodology are public. Three blocks were known-CVE blocks and are classified separately. A 300-package MCP hunting set exposed known over-blocking and is outside the zero-false-block denominator.

Recall is measured on reconstructed, advisory-modeled fixtures because confirmed malware is generally removed from npm; these are not live malware samples. Static tarball inspection also cannot reliably see a later-stage payload fetched only at runtime.

Source and threat model: <https://github.com/adamsjack711-ux/pkgxray>  
Calibration: <https://pkgxray.ca/stats>

I welcome review of the threat model and adjudication method more than reactions to the headline number.

## DEV article

### Title

Inspect what gets installed before it executes: building an evidence-first gate for npm and MCP

### Article

An npm install is not just a file copy. A package may run lifecycle scripts with access to your repository, environment, credentials, shell, and home directory. An AI coding agent can make that decision faster—and with less context—than a person.

The usual order is:

1. choose a dependency;
2. install it;
3. let its install-time behavior run;
4. discover risk later.

pkgxray changes the order: **inspect what gets installed before it executes.**

It is an open-source, zero-runtime-dependency Node.js CLI and MCP server for npm supply-chain and agent security. The fastest way to see the workflow is:

```bash
npx pkgxray guard npm:express@4.21.0
```

### What `guard` actually does

`guard` first queries OSV. A known vulnerable version can be blocked before its tarball is downloaded. The package is then staged in a sandboxed quarantine rather than installed into the project.

pkgxray reads those staged bytes and looks for evidence such as credential access, lifecycle-script behavior, exfiltration shapes, persistence, hidden or computed execution, prompt-injection delivery, and Unicode smuggling. It can compare the published npm artifact with the linked GitHub source and test whether provenance metadata is consistent with the claimed repository. It parses provenance information, but does not overstate that as full local cryptographic verification of the sigstore chain.

The output is a deterministic `SAFE`, `REVIEW`, or `BLOCK` verdict. Every finding identifies the relevant file and evidence. The verdict path does not use an LLM, so text inside a package cannot prompt the decision engine into ignoring its rules.

Most importantly, the normal scan never runs `npm install`, a lifecycle script, a build, or package code. A `SAFE` package can be promoted from quarantine under the default policy. `REVIEW` keeps uncertainty visible instead of silently calling it safe. `BLOCK` is reserved for high-severity cited evidence or a known vulnerability.

### Why this is not another `npm audit`

`npm audit` and OSV-Scanner answer an essential advisory question: does this dependency match a known vulnerability? OSV-Scanner also covers many ecosystems that pkgxray does not, and npm has native remediation and registry-signature tooling.

pkgxray is designed to run beside them. It adds a different question: what risk evidence exists in this exact package artifact before its code runs?

That includes static conduct analysis, npm-to-GitHub divergence, prompt-injection delivery, quarantine-and-promote, verdict drift against a stored baseline, and MCP-specific controls. A freshly trojaned release may not have an advisory yet; static evidence can provide a signal during that gap.

### Agents add a second supply-chain surface

An agent consumes untrusted material in at least two ways: packages it installs and MCP servers it connects to.

pkgxray can itself run as an MCP server:

```json
{ "mcpServers": { "pkgxray": { "command": "pkgxray-mcp" } } }
```

That gives an agent tools for staging a package, auditing supplied evidence, scanning a lockfile, and recording triage decisions.

It can also vet another MCP server:

```bash
pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server
```

The ordering is intentional. A static package scan happens first; only then does pkgxray perform the MCP handshake and request `tools/list`. The manifest audit looks for concealed instructions and capability-surface mismatch, such as a harmlessly named tool whose schema unexpectedly accepts a shell command.

For live stdio sessions, `pkgxray mcp-proxy` can strip denied tools, reject unknown or drifted calls, re-audit after `tools/list_changed`, and scan returned text for injection delivery patterns.

There is an important caveat: enumerating a stdio server requires running it. pkgxray constrains that process with a scrubbed environment, timeout, bounded output, and process-group cleanup, but package-scan-first does not make execution risk disappear.

### A calibration claim needs a denominator

“Zero false positives” would be an indefensible claim. pkgxray makes a narrower, reproducible one:

> 0 heuristic false blocks after calibration on the 2026-07-19 top-1000 most-downloaded npm packages.

The list was ranked using real last-week download counts, pinned to resolved versions, and committed. Anyone can rerun:

```bash
pkgxray guard npm:<name>@<version> --format json
```

over those inputs and re-derive the aggregate result. Known-CVE blocks are separated from heuristic blocks; every heuristic block is manually adjudicated. The fresh run initially surfaced a false block in `registry-url`, whose `.npmrc` read only retrieved a registry URL without reading auth fields or sending data. The heuristic was narrowed, a benign regression fixture was committed, and the full top-1000 set was rerun on the calibrated engine with no heuristic false blocks.

That result is not universal. A separate 300-package MCP hunting set showed that the heuristics over-block the newer MCP ecosystem, where legitimate servers often read environment configuration, spawn processes, ship `.mcp.json`, or quote injection text in defensive documentation. Those results are calibration debt, not part of the top-1000 denominator.

### Detection evidence has limits too

Confirmed malicious npm versions are commonly removed from the registry. The benchmark therefore uses reconstructed samples based on public advisories. They are advisory-modeled fixtures, not live malware, and the published catch rate must be understood in that context.

Static analysis has a deeper boundary: pkgxray reasons about bytes in the tarball. A package can ship a clean loader and fetch a later-stage payload only after installation. pkgxray flags unambiguous loader shapes such as download-and-execute patterns, but it cannot inspect bytes that are not present. High-risk environments still need least privilege, egress controls, and runtime sandboxing.

The opt-in `pkgxray canary` narrows this gap by executing lifecycle scripts with decoy credentials in an OS sandbox. It can confirm observed malicious behavior. It can never clear a package: a quiet run is reported as `not-observed`, not `safe`, and it should run only on a disposable host.

### Know which surfaces are mature

The stable 1.x contract covers the main CLI commands, schema-versioned JSON, exit codes, shared policy, MCP tools, connect-time MCP vetting, stdio runtime proxy, and cache interface.

The browser extension and hookshot install gate are experimental. They work, but their contracts may change without a major release. Canary is supported and explicitly opt-in because it is the exception that executes untrusted code.

### Try it, then inspect the evidence

Start with a package you already know:

```bash
npx pkgxray guard npm:express@4.21.0
```

Then read the threat model, calibration methodology, and source. The goal is not to replace judgment with a green badge. It is to move evidence earlier—before installation—and make the decision reproducible.

Website: <https://pkgxray.ca>  
Repository: <https://github.com/adamsjack711-ux/pkgxray>

## LinkedIn

Software supply-chain controls often arrive after installation. AI agents make that timing problem sharper: they can install an npm package or connect to an MCP server before a person has reviewed either.

pkgxray changes the order: **Inspect what gets installed before it executes.**

```bash
npx pkgxray guard npm:express@4.21.0
```

It quarantines the package, checks OSV, statically analyzes its bytes, compares the npm artifact with linked source, and returns a deterministic verdict with cited evidence—without running package code or lifecycle scripts.

The same project gives agents MCP audit tools, supports package-scan-first server vetting, and can gate live stdio MCP calls.

The public calibration is deliberately scoped and reproducible: 0 heuristic false blocks after calibration on the 2026-07-19 top-1000 most-downloaded set. It is not a promise of zero false blocks everywhere; a separate MCP scan showed known over-blocking. Recall fixtures are reconstructed and advisory-modeled, not live malware. A clean tarball can also fetch a later-stage payload at runtime.

Stable core; experimental browser extension and hookshot integration; supported opt-in canary for behavioral confirmation only.

<https://pkgxray.ca>  
<https://github.com/adamsjack711-ux/pkgxray>

#OpenSource #SupplyChainSecurity #NodeJS #MCP #AISecurity

## X thread

**1/** I built pkgxray around one rule:

**Inspect what gets installed before it executes.**

It is an open-source, zero-runtime-dependency Node CLI + MCP server for npm supply-chain and agent security. <https://pkgxray.ca>

**2/** Try it:

```bash
npx pkgxray guard npm:express@4.21.0
```

It checks OSV, stages the tarball in quarantine, analyzes bytes without running package code, and returns `SAFE`, `REVIEW`, or `BLOCK` with cited evidence.

**3/** It complements `npm audit` and OSV-Scanner. They match known advisories; pkgxray adds pre-install conduct analysis, npm↔GitHub artifact comparison, prompt-injection checks, and verdict-drift monitoring.

**4/** Agents have another supply-chain surface: MCP. pkgxray can be an agent tool, vet a server package + manifest before connection, pin tool fingerprints, and gate drifted or blocked stdio calls through `mcp-proxy`.

**5/** The calibration is public and reproducible. After calibration, the 2026-07-19 top-1000 most-downloaded set recorded **0 heuristic false blocks**. Pinned inputs + method are published.

That denominator matters.

**6/** It does *not* mean zero false blocks everywhere. A separate 300-package MCP scan showed known over-blocking and is outside the claim. The project records that boundary instead of hiding it.

**7/** Recall fixtures are reconstructed from advisories and advisory-modeled—not live malware. Static tarball analysis can also miss a later-stage payload fetched only at runtime. `SAFE` is not proof of total safety.

**8/** Stable: CLI, JSON/exit codes, MCP tools, connect-time vetting, stdio proxy. Experimental: browser extension + hookshot. Canary is opt-in, executes scripts in a sandbox, and can confirm malice but never clear a package.

**9/** Source, methodology, and threat model:

<https://github.com/adamsjack711-ux/pkgxray>  
<https://pkgxray.ca/stats>

## Mastodon thread

**1/6** pkgxray is an open-source Node.js security tool built around a timing change: **Inspect what gets installed before it executes.**

```bash
npx pkgxray guard npm:express@4.21.0
```

<https://pkgxray.ca>

**2/6** `guard` checks OSV, stages a package in quarantine, inspects its bytes without running lifecycle scripts or package code, compares npm contents with linked source, and returns an evidence-cited `SAFE`, `REVIEW`, or `BLOCK`.

**3/6** It also addresses agent/MCP risk: expose pkgxray as an MCP tool, scan a server package before connection, audit the tool manifest, pin fingerprints, and use the stable stdio proxy to deny blocked or drifted calls.

**4/6** Public calibration: 0 heuristic false blocks after calibration on the pinned 2026-07-19 top-1000 most-downloaded set. Inputs and method are reproducible. A separate MCP package scan showed known over-blocking and is explicitly outside that claim.

**5/6** Limits: benchmark malware is reconstructed and advisory-modeled, not live malware. A package can also fetch a later-stage runtime payload absent from its tarball. No scanner proves total safety; use least privilege and sandboxing.

**6/6** Stable core CLI + MCP surfaces. Experimental browser extension and hookshot integration. Canary is supported, opt-in, executes untrusted scripts, and can confirm observed malice but never clear a package.

Source: <https://github.com/adamsjack711-ux/pkgxray>

#SupplyChainSecurity #NodeJS #MCP #AISecurity

## GitHub Discussions

### Title

pkgxray launch: pre-install npm inspection and MCP security, with public calibration

### Post

pkgxray is ready for broader use and review: **Inspect what gets installed before it executes.**

Start here:

```bash
npx pkgxray guard npm:express@4.21.0
```

The stable core includes package quarantine, OSV pre-checks, deterministic static analysis, evidence-cited verdicts, lockfile scanning, `recheck`, schema-versioned JSON, shared policy, four agent-facing MCP tools, package-scan-first MCP vetting, and a stdio runtime proxy.

The 2026-07-19 calibration is public and reproducible from committed inputs. Its precise result is 0 heuristic false blocks after calibration on the top-1000 most-downloaded set. Please do not restate that as zero false blocks generally: an MCP-focused 300-package scan showed known over-blocking outside the denominator.

Known-malware benchmark cases are reconstructed, advisory-modeled fixtures—not live malware. The main static scanner cannot see a later-stage payload fetched only at runtime. `SAFE` means no high- or medium-risk signal in the inspected evidence, not proof of harmlessness.

Experimental surfaces are the browser extension and hookshot integration. Canary is supported but opt-in, executes untrusted lifecycle scripts, and can only confirm behavior it observes.

Discussion prompts:

1. Which evidence should move between `REVIEW` and `BLOCK`?
2. Which legitimate MCP package patterns should become calibration fixtures?
3. Which additional reproducible corpora would improve the claim without turning results into an attacker oracle?

Docs and calibration: <https://pkgxray.ca>  
Repository: <https://github.com/adamsjack711-ux/pkgxray>

## MCP community

### Title

Package-scan-first MCP vetting and runtime tool gating with pkgxray

### Post

MCP security starts before `tools/list`: the server package itself is part of the trust boundary.

pkgxray applies the rule **inspect what gets installed before it executes** to both sides of an agent workflow. It can give an agent package-audit tools, statically scan an MCP server package before connection, audit the live manifest for injection delivery and capability-surface mismatch, pin tool fingerprints, and gate stdio calls through a runtime proxy.

```bash
npx pkgxray guard npm:some-mcp-server@1.4.2
pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server
```

The second command eventually spawns the stdio server to enumerate its tools. Package-scan-first, a scrubbed environment, timeout, bounded output, and process cleanup reduce that risk; they do not eliminate it.

Calibration needs an MCP-specific warning. The published 0 result applies only to heuristic false blocks after calibration on the 2026-07-19 top-1000 most-downloaded npm set. A separate 300-package MCP hunting set showed known over-blocking from legitimate environment reads, process spawning, `.mcp.json`, and defensive docs. Contributions that turn those cases into safe, narrowly-scoped fixtures are welcome.

The known-malware corpus is reconstructed and advisory-modeled, not live malware, and tarball analysis cannot see a later-stage runtime payload. Use pkgxray with permission boundaries and sandboxing.

Stable: MCP server tools, `pkgxray mcp`, and stdio `mcp-proxy`. Experimental: browser extension and hookshot integration. Canary is opt-in and never clears a server package.

<https://pkgxray.ca> · <https://github.com/adamsjack711-ux/pkgxray>

## Newsletter email

### Subject

Before `npm install`: meet pkgxray

### Preheader

Evidence-first npm and MCP inspection, with a reproducible public calibration.

### Body

Hi {{first_name}},

An AI agent can install a package or connect to an MCP server before anyone reads the code or tool manifest. pkgxray changes that order:

**Inspect what gets installed before it executes.**

```bash
npx pkgxray guard npm:express@4.21.0
```

pkgxray checks OSV, stages the package in quarantine, statically analyzes its bytes, compares the npm artifact with linked source, and returns a deterministic `SAFE`, `REVIEW`, or `BLOCK` verdict with cited evidence. The normal scan does not run lifecycle scripts or package code.

It also works in agent workflows: use pkgxray as an MCP tool, vet server packages and manifests before connection, pin approved tool fingerprints, and gate live stdio calls.

The public calibration can be reproduced from committed inputs. After calibration, the 2026-07-19 top-1000 most-downloaded set recorded 0 heuristic false blocks. This is a scoped result, not a guarantee across npm: a separate MCP scan showed known over-blocking. Benchmark malware samples are reconstructed and advisory-modeled rather than live malware, and static inspection may miss a later-stage runtime payload.

The core CLI and MCP surfaces are stable. The browser extension and hookshot integration are experimental. Canary is supported, opt-in, and can confirm observed malicious behavior but never clear a package.

[Try pkgxray](https://pkgxray.ca)  
[Read the source and threat model](https://github.com/adamsjack711-ux/pkgxray)

— Jack

## Podcast guest pitch

### Subject

Guest idea: what “scan before install” changes for npm and AI agents

### Pitch

Hi {{name}},

I would like to propose a technically specific episode about a gap in software supply-chain security: known-vulnerability scanners are essential, but a newly trojaned npm release or malicious MCP server may have no advisory when an AI agent reaches it.

I built pkgxray around the rule **inspect what gets installed before it executes**. It quarantines npm packages, checks OSV, analyzes package bytes without running them, cites the evidence behind each verdict, and extends the same trust model to MCP manifests and live stdio tool calls.

The useful episode is not “a scanner makes you safe.” It is how to make security claims falsifiable:

- why the public claim is narrowly 0 heuristic false blocks after calibration on the 2026-07-19 top-1000 most-downloaded set;
- how a fresh list exposed a real false block that a stale corpus missed;
- why a separate MCP scan still over-blocks and is excluded from that denominator;
- why the malware corpus is reconstructed and advisory-modeled, not live malware;
- why static analysis cannot see a later-stage payload that arrives only at runtime;
- how deterministic evidence differs from an LLM judging untrusted text;
- where stable MCP controls end and experimental browser/hook integrations begin;
- why the opt-in canary can confirm observed malice but never certify safety.

Listeners could follow along immediately:

```bash
npx pkgxray guard npm:express@4.21.0
```

Project and public methodology: <https://pkgxray.ca>  
Source: <https://github.com/adamsjack711-ux/pkgxray>

I can bring concise demos and discuss both the implementation and the places it fails.

Best,  
Jack Adams-Lovell

## Product Hunt — optional, low priority

Use only after technical communities have produced real questions, quotes, and issue reports. Product Hunt is less well matched to a developer-security tool than HN, Node.js, cybersecurity, and MCP communities.

### Tagline

Inspect npm packages and MCP servers before they execute

### Description

pkgxray is a local, zero-runtime-dependency Node.js CLI and MCP server that quarantines npm packages, checks known vulnerabilities, statically analyzes code and metadata, compares published artifacts with linked source, and returns evidence-cited verdicts before installation. It also supports agent-facing audit tools, package-scan-first MCP vetting, and stable stdio runtime gating.

```bash
npx pkgxray guard npm:express@4.21.0
```

The public calibration recorded 0 heuristic false blocks after calibration on the 2026-07-19 top-1000 most-downloaded set, with reproducible inputs and methodology. This is not a universal safety claim: MCP packages are known to be over-blocked, benchmark samples are reconstructed/advisory-modeled rather than live malware, and later-stage runtime payloads can evade tarball-only analysis.

Stable core; experimental browser extension and hookshot; supported opt-in canary that can confirm malice but never clear a package.

<https://pkgxray.ca>  
<https://github.com/adamsjack711-ux/pkgxray>
