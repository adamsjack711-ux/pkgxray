# pkgxray press and newsletter kit

This document is source material for journalists, editors, newsletter authors,
podcast hosts, and event producers. It describes pkgxray **v1.0.3**. Claims
should remain within the boundaries in the [claim-status table](#claim-status).

## Project summary

pkgxray is an MIT-licensed, zero-runtime-dependency Node.js tool for examining
npm packages and Model Context Protocol (MCP) servers for supply-chain risk. Its
local static-analysis path stages package contents in quarantine, checks known
vulnerabilities and integrity evidence, and applies deterministic heuristics for
behaviors such as credential access, exfiltration, persistence, obfuscation,
prompt injection, and Unicode smuggling. It reports `SAFE`, `REVIEW`, or `BLOCK`
with cited evidence before package code or lifecycle scripts run.

The qualification above matters: the default package-analysis path is local and
static, but two explicitly separate operations execute code. `pkgxray mcp` must
spawn a stdio MCP server to enumerate its tools, and the supported opt-in
`pkgxray canary` command deliberately executes package lifecycle scripts in a
sandbox. Canary can confirm observed malicious behavior; it cannot clear a
package.

## Maintainer bio

> **MAINTAINER BIO PLACEHOLDER — approval and text required.**
>
> Do not infer a biography from the package author field, repository history,
> social profiles, employer, school, location, or other sources. Insert only
> maintainer-supplied, explicitly approved copy here.

- Name in package metadata: Jack Adams-Lovell
- Approved short bio: **[MAINTAINER TO SUPPLY]**
- Approved long bio: **[MAINTAINER TO SUPPLY]**
- Approved pronouns: **[MAINTAINER TO SUPPLY]**
- Approved title/affiliation: **[MAINTAINER TO SUPPLY OR MARK INDEPENDENT]**
- Approved contact for press: **[MAINTAINER TO SUPPLY]**

## Project facts sheet

| Item | Fact |
|---|---|
| Project | pkgxray |
| Current version | **1.0.3** |
| v1.0.3 release date | 2026-07-18 |
| v1.0.3 release type | Documentation-only; package code and behavior are identical to v1.0.2 |
| License | MIT |
| Runtime | Node.js **>=18** |
| Runtime dependencies | **Zero** |
| Primary ecosystem | npm packages; MCP servers and agent tooling |
| Main interfaces | CLI, MCP server, connect-time MCP audit, stdio MCP runtime proxy, CI/cache integrations |
| Static package path | Runs locally; quarantines and inspects package bytes without running package code, lifecycle scripts, or build steps |
| Verdicts | `SAFE`, `REVIEW`, `BLOCK` |
| Stable exit codes | `0` safe/allow, `2` block, `3` review |
| Stable JSON contract | `schemaVersion: 1`; additive fields within the schema version |
| Stable MCP surfaces | `pkgxray mcp` and `pkgxray mcp-proxy` |
| Supported opt-in surface | `pkgxray canary`; executes untrusted lifecycle scripts and cannot clear a package |
| Experimental surfaces | Browser extension and hookshot integration |
| Analysis design | Deterministic heuristics; no LLM in the verdict path; findings cite evidence |
| Provenance handling | Parses SLSA provenance, binds/checks subject digests, and cross-checks repository claims; does **not** perform complete Sigstore/Fulcio/Rekor cryptographic verification under the zero-dependency constraint |
| Calibration claim | 0 heuristic false blocks on the top-1000 most-downloaded npm packages in the 2026-07-19 revalidation |
| Calibration boundary | The claim applies only to that top-1000 set, not all npm packages; a separate 300-package MCP-ecosystem scan found known over-blocking |
| Known structural blind spot | A clean tarball can download its real payload at install time or later; static inspection cannot fully observe that later-stage runtime payload |
| Website | <https://pkgxray.ca/> |
| Source | <https://github.com/adamsjack711-ux/pkgxray> |
| npm | <https://www.npmjs.com/package/pkgxray> |

## Claim status

Use the exact status and caveat when quoting a capability. “Stable” describes a
compatibility contract, not a guarantee that every verdict is correct.

| Status | Claim or surface | What may be said | Required boundary |
|---|---|---|---|
| **Implemented — Stable** | `pkgxray guard`, lockfile audit, `recheck`, JSON output, config, and exit codes | These are implemented and covered by the 1.x compatibility contract. | Detection may evolve; a prior `safe` result can later become `review` or `block`. |
| **Implemented — Stable** | `pkgxray mcp` | It audits an MCP tool manifest at connect time and supports package-scan-first, pin, and recheck workflows. | Enumerating a stdio server requires spawning it; package-scan-first narrows but does not remove execution risk. |
| **Implemented — Stable** | `pkgxray mcp-proxy` | It gates calls to a live stdio MCP server, strips denied tools, reacts to `tools/list_changed`, checks pinned-manifest drift, and scans tool-result text. | It wraps stdio children, not HTTP servers. Prompt-injection scanning reduces exposure; it does not “solve” prompt injection. |
| **Implemented — Stable** | Local static package-analysis path | It runs locally and does not execute package code, lifecycle scripts, or build steps. | Do not generalize this no-execution claim to canary or stdio MCP enumeration. Network lookups are used for registry, OSV, and repository evidence. |
| **Implemented — Stable** | Provenance and npm-to-GitHub checks | Provenance is parsed and cross-checked with subject digest and repository/artifact evidence. | Do not call this complete cryptographic provenance verification. Full Sigstore/Fulcio/Rekor verification is outside the zero-dependency design. |
| **Implemented — Stable** | Top-1000 calibration | A 2026-07-19 revalidation measured 0 heuristic false blocks on the top-1000 npm packages ranked by real last-week downloads, after one surfaced false block was fixed and added as a regression fixture. | This is not a claim of zero false blocks across npm, future inputs, or MCP packages. Known-CVE blocks are counted separately. |
| **Supported, opt-in** | `pkgxray canary` | It executes install lifecycle scripts with explicit consent and can confirm observed malicious behavior using sandboxing and decoys. | It executes untrusted code. A quiet result is `not-observed`, never `safe`; canary cannot clear a package. Use a disposable host and `--require-sandbox`. |
| **Experimental** | Browser extension | An MV3 load-unpacked extension exists and can be built from the repository. | It is not published to a browser store and may change or be removed without a major release. |
| **Experimental** | Hookshot integration | An install-gate example exists for Hookshot-compatible agent hooks. | It depends on an external hook ABI and may change or be removed without a major release. |
| **Planned / not currently claimed** | Canary TLS termination | Per-run TLS termination could make credential tokens inside HTTPS bodies directly inspectable. | Not implemented; do not imply HTTPS bodies are currently inspected. |
| **Planned / not currently claimed** | Loopback-only Linux network namespace | A future Linux setup could block all non-proxied egress while preserving the capture proxy. | Not implemented; `bwrap` and `env-only` currently share networking. |
| **Limitation** | Later-stage runtime payloads | pkgxray can flag visible loader capability in package bytes. | A package can ship a clean tree and fetch its real payload after install or on first use. Pair static analysis with runtime controls where this risk matters. |
| **Limitation** | MCP false positives | MCP-oriented packages are scanned by the same engine. | A 2026-07-19 scan of 300 MCP-ecosystem packages found known heuristic over-blocking; this ecosystem is outside the top-1000 claim. |
| **Limitation** | Prompt injection | Deterministic verdicts cannot be steered by injected prose, and delivery patterns are scanned. | pkgxray does not claim to solve prompt injection or replace least-privilege controls in the consuming agent. |
| **Limitation** | Canary isolation | macOS `sandbox-exec`, Linux `bwrap`, resource caps, scrubbed environment, decoy home, and a non-forwarding proxy provide defense in depth when available. | Sandbox escape remains possible. `env-only` lacks OS filesystem confinement; raw-socket traffic can remain uncaptured on `bwrap`/`env-only`; only lifecycle scripts run. |

## Technical differentiators

1. **Pre-install evidence rather than post-execution detection.** The static
   `guard` path acquires evidence, stages content in quarantine, audits it, and
   promotes it only when policy permits. It does not call `npm install`.
2. **Behavior-oriented static checks plus known-vulnerability checks.** OSV
   answers whether a vulnerability is already published; static heuristics look
   for suspicious behavior in a new or trojaned artifact that may have no CVE.
3. **Deterministic, citable verdicts.** No LLM participates in the verdict path.
   Findings identify the file and evidence that triggered them.
4. **Artifact and source cross-checks.** pkgxray compares the npm tarball with
   linked tagged GitHub source and treats divergence as review evidence rather
   than automatically declaring malware.
5. **One policy across surfaces.** The CLI, MCP server, and proxy read the same
   `.pkgxray.json` model, including fail-closed scan errors and the invariant
   that known vulnerabilities cannot be muted or allowed away.
6. **MCP controls at two timescales.** `pkgxray mcp` audits before connection;
   `mcp-proxy` gates live stdio calls, manifest changes, pinned drift, and tool
   result text.
7. **Measured calibration with a narrow claim.** A committed fixture benchmark
   fails on false blocks and complete misses, while at-scale validation tests the
   separately scoped top-1000 statement. Known MCP over-blocking is disclosed
   rather than folded into the broader claim.
8. **Zero runtime dependencies.** The project implements its runtime with Node
   built-ins, trading away complete Sigstore/Fulcio/Rekor verification rather
   than presenting parsed provenance as cryptographic proof.

## Limitations editors should retain

- pkgxray examines package bytes, not every behavior a package may exhibit later.
  A downloaded second stage or payload activated on first import can evade the
  static view.
- `SAFE` means no high- or medium-risk indicator was found in the available
  evidence. It is not a mathematical proof that a package is harmless.
- The top-1000 result is a scoped calibration result, not a registry-wide
  guarantee. MCP ecosystem packages are known to be over-blocked.
- Parsed and cross-checked provenance is not full cryptographic attestation
  verification.
- Connect-time stdio MCP inspection runs the server long enough to list tools.
- Canary executes untrusted lifecycle scripts and can only add positive evidence;
  it cannot turn a static `review` or `block` into a clearance.
- MCP runtime gating does not wrap HTTP servers, and injection detection does not
  replace capability restrictions or human review.
- Experimental integrations do not carry the 1.x Stable compatibility promise.

## FAQ

### Is pkgxray a replacement for `npm audit` or OSV-Scanner?

No. It is designed to run alongside them. Known-vulnerability lookup is one
layer; pkgxray adds static behavior checks, quarantine, npm-to-GitHub comparison,
provenance cross-checking, prompt-injection indicators, drift monitoring, and
MCP-specific controls. OSV-Scanner also covers ecosystems beyond npm, while
pkgxray's package focus is npm.

### Does pkgxray run the package it scans?

The normal local static package path does not. It inspects a quarantined copy
without running lifecycle scripts, builds, or package code. The exceptions must
be stated separately: `pkgxray canary` deliberately executes lifecycle scripts
after explicit opt-in, and connect-time inspection of a stdio MCP server spawns
that server to request `tools/list`.

### What does `SAFE` mean?

It means no high- or medium-risk indicators were found in the evidence pkgxray
examined. It does not prove the absence of malicious behavior, especially a
later-stage payload not present in the tarball.

### Does it use AI to decide whether a package is malicious?

No. The verdict path uses deterministic heuristics. This keeps package text,
including prompt injection, from steering an LLM-based security decision.

### Does pkgxray verify npm provenance?

It parses SLSA provenance, checks subject-digest binding, and cross-checks the
claimed repository and artifact. Under its zero-runtime-dependency constraint,
it does not perform complete Sigstore/Fulcio/Rekor cryptographic verification.
Copy should say “parsed and cross-checked,” not simply “cryptographically
verified.”

### What exactly is the top-1000 result?

In a 2026-07-19 revalidation against 1,000 npm packages ranked by real last-week
download counts, pkgxray recorded zero heuristic false blocks after a surfaced
false block in `registry-url` was fixed and preserved as a benign regression
fixture. Three correct known-CVE blocks were reported separately. The claim does
not cover all npm packages or the MCP ecosystem.

### Why are so many top-1000 results `REVIEW`?

`REVIEW` is deliberately different from a false `BLOCK`. It covers incomplete
or governance evidence and privileged dual-use capabilities that merit a human
decision. The 2026-07-19 run reported 661 review, 334 safe, one scan error, three
known-CVE blocks, and zero heuristic false blocks after retuning.

### How does pkgxray handle MCP servers?

The Stable `pkgxray mcp` surface audits a server's advertised tool manifest at
connect time and can pin or recheck it. The Stable stdio-only `mcp-proxy`
filters denied tools and calls, re-audits manifest-change notifications, checks
pinned drift, and scans tool-result text. A separate `pkgxray-mcp` server exposes
pkgxray's own audit tools to MCP-capable agents.

### Is the browser extension production-ready?

It is Experimental, load-unpacked, and not published to a browser store. The
Hookshot integration is also Experimental.

### What changed in v1.0.3?

Only documentation and presentation: a shorter npm README, npm-compatible
formatting fixes, a corrected link, and website source/social card assets in the
repository. There were no code, dependency, or behavior changes from v1.0.2.

## Logo and screenshot requirements

### Available project artwork

- [`docs/banner.svg`](../banner.svg) — repository banner artwork.
- [`docs/social-preview.svg`](../social-preview.svg) — repository social-preview
  artwork.
- [`website/assets/og.jpg`](../../website/assets/og.jpg) — 1200×630 website
  social-share image, if present in the checked-out website assets.
- [`website/assets/favicon.svg`](../../website/assets/favicon.svg) — small
  website mark; do not treat it as the primary press logo without approval.
- [`docs/demo/hero.gif`](../demo/hero.gif) and the linked 60-second walkthrough
  in the README — real `guard` runs showing a safe package and a blocked sample.
- [`docs/screenshots/mcp-proxy.png`](../screenshots/mcp-proxy.png),
  [`hookshot.png`](../screenshots/hookshot.png), and
  [`browser-extension.png`](../screenshots/browser-extension.png) — documented
  captures for Stable and Experimental surfaces.

### Publication requirements

1. Request the original/vector file from the maintainer when a publication
   requires print resolution, a transparent background, or a standalone logo.
2. Preserve aspect ratio, padding, colors, and legibility. Do not redraw,
   recolor, rotate, crop through terminal evidence, or place text over findings.
3. Label screenshots by surface. In particular, identify the browser extension
   and Hookshot image as **Experimental**.
4. Use captions that distinguish the benign and intentionally malicious sample;
   do not imply the sample is a finding against the real package it models.
5. Do not edit terminal output in a way that changes a verdict, grade, finding,
   filename, evidence, or timing. The repository documents reproduction steps
   in [`docs/screenshots/README.md`](../screenshots/README.md).
6. Supply alt text. Existing README and website metadata contain approved
   descriptive starting points, but final alt text remains subject to approval.
7. Credit line: **[MAINTAINER TO APPROVE CREDIT WORDING]**.
8. Asset approval: **[MAINTAINER TO APPROVE EXACT FILES AND USAGE]**.

## Suggested interview questions

1. What threat model led you to inspect packages before installation rather than
   only checking behavior after execution?
2. How do you separate a high-confidence block from a capability that should
   merely prompt review?
3. What did the fresh 2026 top-1000 ranking reveal that the older package list
   missed?
4. Why is the zero-false-block statement deliberately limited to the top-1000
   set?
5. What kinds of MCP packages are currently over-blocked, and how do you narrow a
   heuristic without opening an evasion route?
6. Why keep the verdict path deterministic instead of asking an LLM to interpret
   suspicious code or documentation?
7. What assurance is gained from parsing and cross-checking provenance, and what
   remains unavailable without full cryptographic verification?
8. How does `mcp-proxy` respond when a server changes its tools after approval?
9. Why can a canary confirm malicious behavior but never clear a package?
10. Where should static package analysis sit alongside OSV, `npm audit`, runtime
    sandboxing, least privilege, and human review?
11. Which 1.x interfaces are stable enough for CI or agent-platform integrations,
    and which remain Experimental?
12. What would be required to reduce the later-stage payload blind spot?

## One-paragraph release announcement

pkgxray v1.0.3 is available under the MIT license for Node.js 18 and newer.
pkgxray is a zero-runtime-dependency, local supply-chain scanner for npm packages
and MCP servers: its static package path quarantines and examines artifacts
before package code runs, returning evidence-backed `SAFE`, `REVIEW`, or `BLOCK`
verdicts, while Stable `mcp` and `mcp-proxy` surfaces cover connect-time and live
stdio MCP controls. The top-1000 calibration claim is precisely scoped to zero
heuristic false blocks on the 1,000 most-downloaded npm packages in the
2026-07-19 revalidation, not the whole registry; known MCP over-blocking and the
later-stage payload blind spot are documented. Version 1.0.3 itself is a
documentation-only release with no code, dependency, or behavior changes from
1.0.2.

## Long-form release announcement

**pkgxray v1.0.3 packages pre-install npm and MCP supply-chain checks in a
zero-runtime-dependency Node.js tool**

pkgxray v1.0.3 is now available for Node.js 18 and newer under the MIT license.
It gives developers, CI systems, and AI-agent operators a local way to inspect
npm packages before installation and to evaluate MCP servers before and during
a connection.

The normal package path is static. `pkgxray guard` obtains evidence, stages the
package in quarantine, checks known vulnerabilities and artifact integrity, and
applies deterministic heuristics without running `npm install`, lifecycle
scripts, build steps, or package code. Reports use `SAFE`, `REVIEW`, and `BLOCK`
decisions and cite the files and evidence behind findings. Because no LLM sits
in the verdict path, prompt-injection text inside a package cannot steer the
decision engine.

The analysis combines questions that are often handled separately: whether OSV
already records a vulnerability; whether the published npm artifact agrees with
tagged GitHub source; whether parsed provenance is consistent with its subject
and repository claim; and whether package bytes contain high-risk behavior or
concealed instructions. Provenance language is intentionally conservative:
pkgxray parses and cross-checks it, but does not claim complete
Sigstore/Fulcio/Rekor cryptographic verification under its zero-dependency
constraint.

For MCP, two 1.x Stable surfaces address different points in time. `pkgxray mcp`
audits the tool manifest at connection and supports package-scan-first, pin, and
recheck workflows. `pkgxray mcp-proxy` wraps a stdio server during a live
session, filters denied tools and calls, rechecks manifest changes, denies
unapproved pinned drift, and scans tool-result text. Connect-time enumeration of
a stdio server necessarily spawns it; HTTP servers can be audited at connect
time but are not wrapped by the runtime proxy.

Calibration is published with its boundary. A 2026-07-19 revalidation against
the top-1000 npm packages ranked by real last-week download counts measured zero
heuristic false blocks after one false block was surfaced, corrected, and added
as a permanent benign fixture. The result does not claim zero false blocks for
the whole registry. A separate 300-package MCP-ecosystem scan found known
over-blocking, which remains disclosed calibration debt.

Static analysis also has a structural limit: a package can ship a clean tarball
and retrieve a payload after installation or on first use. pkgxray can flag an
unambiguous loader in the bytes it sees, but it cannot observe every later-stage
runtime payload. The supported, explicitly opt-in `pkgxray canary` command can
execute lifecycle scripts in a sandbox to seek behavioral evidence, but it runs
untrusted code and can never clear a package; a quiet run means only that malice
was not observed in that run.

The browser extension and Hookshot integration remain Experimental. The core
CLI contracts, JSON schema, exit codes, MCP audit, and stdio MCP proxy are
Stable under the 1.x compatibility policy.

Version 1.0.3 is a documentation-only release: it shortens and corrects the npm
README and brings website source and social-share assets into the repository.
The package code, runtime dependencies, and behavior are unchanged from v1.0.2.

Project website: <https://pkgxray.ca/>  
Source and documentation: <https://github.com/adamsjack711-ux/pkgxray>  
npm package: <https://www.npmjs.com/package/pkgxray>

## Journalist and editor links

### Primary

- Website: <https://pkgxray.ca/>
- GitHub repository: <https://github.com/adamsjack711-ux/pkgxray>
- npm package: <https://www.npmjs.com/package/pkgxray>
- v1.0.3 changelog entry:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/CHANGELOG.md#103-2026-07-18--a-shorter-sharper-readme>
- MIT license:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/LICENSE>

### Evidence, scope, and contracts

- Threat model:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/docs/threat-model.md>
- Canary threat model:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/docs/canary-threat-model.md>
- Benchmark and claim scope:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/docs/benchmark.md>
- Top-1000 validation summary:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/validation/README.md>
- MCP guide:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/docs/mcp.md>
- Compatibility and stability contract:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/docs/compatibility.md>
- Screenshot provenance and reproduction:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/docs/screenshots/README.md>
- Security reporting:
  <https://github.com/adamsjack711-ux/pkgxray/blob/main/SECURITY.md>

## Approval placeholders

Publication approval is not implied by this draft.

- Technical claim review: **[NAME / DATE / STATUS]**
- Maintainer biography approval: **[NAME / DATE / STATUS]**
- Maintainer name, pronouns, title, and affiliation approval:
  **[NAME / DATE / STATUS]**
- Quote approval (if quotes are later added): **[NAME / DATE / STATUS]**
- Release-announcement approval: **[NAME / DATE / STATUS]**
- Logo and screenshot selection approval: **[NAME / DATE / STATUS]**
- Asset credit and trademark wording approval: **[NAME / DATE / STATUS]**
- Press contact and embargo details: **[CONTACT / EMBARGO OR “NONE” / STATUS]**
- Final editorial sign-off: **[NAME / DATE / STATUS]**
