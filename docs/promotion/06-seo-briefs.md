# SEO content briefs

These briefs are grounded in the current README, changelog, threat model, MCP
guide, benchmark documentation, calibration pages, and website source. They are
editorial plans, not published product pages.

## Verified routes and shared claim boundaries

The website source verifies these public routes:

- `/` — product landing page
- `/stats` — latest aggregate calibration
- `/stats/methodology` — calibration methodology
- `/stats/2026-07-19` and `/stats/2026-07-19-retuned` — immutable run pages

The source does **not** verify `/methodology` or any of the proposed SEO routes
below. Every new route is therefore labelled **proposed**. Before publication,
confirm that `pkgxray.ca` serves the same site; the repository currently names
`pkgxray.pages.dev` as the live site and canonical host.

Apply these boundaries to all nine pages:

- Describe pkgxray as a deterministic, evidence-citing static scanner and
  pre-install policy gate, not as proof that a package or server is safe.
- `SAFE` means no high- or medium-risk indicators were found in the evidence
  examined. It does not mean harmless, trusted, or guaranteed malware-free.
- Static package analysis reasons about bytes shipped in the tarball. A package
  can fetch a later-stage payload after installation while shipping a clean
  tree. pkgxray can flag recognizable loader capabilities, but runtime
  sandboxing and least privilege remain necessary where that risk matters.
- The opt-in canary can confirm behavior it observes; a quiet run is
  `not-observed`, never proof of safety.
- The measured claim is **0 heuristic false blocks on the top 1,000
  most-downloaded npm packages** in the 2026-07-19 retuned run. It is not a
  registry-wide zero-false-positive claim.
- The known-malware corpus result is **19 of 20 blocked, 0 of 20 passed as
  safe**; the remaining sample routed to review. Call this corpus recall, not
  live-registry recall.
- Do not extend top-1,000 calibration to MCP packages. The separate 300-package
  MCP hunting list exposed over-blocking and unresolved calibration debt.
- Provenance support is parser-only. pkgxray decodes and reads SLSA-shaped DSSE
  claims and can compare their claimed repository with package metadata. It
  does **not** cryptographically verify the Sigstore signature, Fulcio chain,
  Rekor inclusion proof, or—on the current guard path—the downloaded tarball's
  subject binding. Full Sigstore verification is out of scope under the
  zero-dependency constraint. Parsed provenance is informational and must never
  move a verdict toward safe.

## 1. npm malware scanner

**Proposed route:** `/npm-malware-scanner`

**Search intent:** Commercial investigation with a practical evaluation layer.
The searcher wants a tool that examines npm package contents for malicious
behavior, and needs to understand how this differs from CVE lookup.

**Recommended title:** npm Malware Scanner for Pre-Install Package Analysis

**Meta description:** Scan npm package contents before install for credential
access, loaders, persistence, obfuscation, and prompt injection—with cited
evidence and scoped verdicts.

**Page outline:**

1. Define an npm malware scanner: behavior and trust signals, not just CVEs.
2. Show the pre-install flow: resolve, OSV pre-check, quarantine, static
   analysis, policy verdict, optional promotion.
3. Explain the evidence categories with restrained examples: credential reads,
   persistence, download-and-execute, encoded payloads, and artifact divergence.
4. Contrast malware heuristics with `npm audit` and OSV rather than presenting
   them as substitutes.
5. Walk through `SAFE`, `REVIEW`, and `BLOCK`, including stable exit codes and
   the limited meaning of `SAFE`.
6. Present calibration: top-1,000 false-block scope and reconstructed-corpus
   catch rate.
7. Close with static-analysis blind spots and a layered-defense checklist.

**Questions to answer:**

- Can an npm scanner detect malware that has no CVE?
- Does pkgxray install or execute the package it scans?
- What evidence causes review versus block?
- How should a team interpret a safe verdict?
- Can a static scanner catch a payload downloaded after install?

**Internal links:**

- Existing `/` — product overview and copyable guard command
- Existing `/stats` — current aggregate calibration
- Existing `/stats/methodology` — corpus, adjudication, and reproduction details
- Proposed `/scan-npm-package-before-installing` — task-focused tutorial
- Proposed `/malicious-npm-package-detection` — detector and limitation detail

**Claims requiring citations:**

- Current npm malware volume or publishing-rate claims: cite the dated Sonatype
  primary report, preserve its package/release denominator, and avoid converting
  it into an install probability.
- Detection and no-execution claims: cite the repository architecture and threat
  model, tied to a release or commit.
- Calibration figures: cite `/stats` and `/stats/methodology`, including date,
  version, corpus size, and denominator.
- Any comparison with `npm audit` or OSV-Scanner: cite each tool's current
  official documentation.

**CTA:** Run `npx pkgxray guard npm:<name>@<version>` and inspect the cited
findings before deciding whether to install.

## 2. npm supply-chain security

**Proposed route:** `/npm-supply-chain-security`

**Search intent:** Broad informational and solution-comparison intent. The
searcher is designing controls for dependency intake, compromised releases,
artifact tampering, known vulnerabilities, and ongoing version drift.

**Recommended title:** npm Supply-Chain Security: A Layered Pre-Install Workflow

**Meta description:** Build an npm supply-chain workflow across CVEs, package
behavior, artifact comparison, parsed provenance, quarantine, policy, and
post-install rechecks.

**Page outline:**

1. Model the npm trust chain: publisher, registry metadata, tarball, source tag,
   build claim, install scripts, and transitive dependency graph.
2. Separate four questions: known vulnerability, malicious behavior, artifact
   identity/divergence, and change over time.
3. Map pkgxray controls to lifecycle stages: OSV pre-check, quarantine and
   static scan, npm-to-GitHub comparison, provenance-claim comparison, policy,
   and `recheck`.
4. Explain compromised-maintainer and trojaned-update scenarios without
   reducing supply-chain security to typosquatting.
5. Give CI and developer-workstation patterns for lockfiles and single-package
   intake.
6. Document trust-signal hierarchy: a matching repository or parsed attestation
   is context, never an offset for malicious conduct.
7. Finish with gaps: runtime payloads, social trust, registry/account controls,
   and least privilege.

**Questions to answer:**

- What layers belong in an npm supply-chain security program?
- Why is a clean CVE result insufficient for a newly trojaned release?
- How can teams compare an npm tarball with its linked source?
- What can provenance establish, and what does pkgxray actually verify?
- How do teams detect verdict or version drift after adoption?

**Internal links:**

- Existing `/` — product architecture summary
- Existing `/stats` — measured scanner calibration
- Existing `/stats/methodology` — exact calibration scope
- Proposed `/npm-package-provenance-verification` — parser-only provenance detail
- Proposed `/malicious-npm-package-detection` — behavior-focused detection

**Claims requiring citations:**

- Registry scale, malicious publishing, or major compromise blast radius: cite
  primary research and clearly state the measurement period.
- Statements about npm provenance and `npm audit signatures`: cite current npm
  documentation.
- pkgxray's npm-to-GitHub comparison and `recheck` behavior: cite versioned
  repository docs and tests.
- Every performance or calibration number: cite the dated method and environment.

**CTA:** Add a pre-install guard for new packages and a scheduled `recheck` for
accepted dependencies; keep existing vulnerability and runtime controls.

## 3. scan npm package before installing

**Proposed route:** `/scan-npm-package-before-installing`

**Search intent:** High-intent how-to. The searcher has a package name now and
wants a low-friction command, output interpretation, and safe next step.

**Recommended title:** How to Scan an npm Package Before Installing It

**Meta description:** Stage and statically scan an npm tarball before install,
read SAFE/REVIEW/BLOCK evidence, and promote only when policy permits—without
running package code.

**Page outline:**

1. Start with the copyable command:
   `npx pkgxray guard npm:<name>@<version>`.
2. Explain why an exact version is preferable to an unpinned specifier for
   review and reproducibility.
3. Show what happens before execution: OSV query, tarball fetch, private
   quarantine, static analysis, and no lifecycle/build steps.
4. Teach output reading: decision, grade, finding severity, file, snippet,
   quarantine path, and exit code.
5. Give decision playbooks:
   - `SAFE`: still apply normal review and least privilege;
   - `REVIEW`: inspect cited evidence and quarantined content;
   - `BLOCK`: do not promote; investigate or choose another version.
6. Add JSON/CI usage and promotion policy without implying automation removes
   human accountability.
7. Explain scan errors and the later-stage payload blind spot.

**Questions to answer:**

- Can I inspect an npm package without running `npm install`?
- Does `npx pkgxray` itself install the target package?
- What do exit codes 0, 2, and 3 mean?
- What should I do with a review verdict?
- Should I scan a package again when its version changes?

**Internal links:**

- Existing `/` — interactive demo and install command
- Existing `/stats` — current measured results
- Existing `/stats/methodology` — how verdict performance was measured
- Proposed `/npm-malware-scanner` — conceptual scanner comparison
- Proposed `/npm-supply-chain-security` — CI and monitoring controls

**Claims requiring citations:**

- Exact command behavior, quarantine, promotion, and exit codes: cite the current
  CLI/reference docs for the published version.
- “Never executes target code” must be scoped to `guard`; cite architecture and
  distinguish the opt-in canary and stdio MCP enumeration.
- Timing examples require hardware, Node version, cache state, package version,
  and measurement source.
- Any statement about `npx` behavior should cite npm's current official docs and
  avoid claiming that all `npx` use is execution-free.

**CTA:** Replace the example with the exact package and version you are
considering, run the guard, and review the evidence before promotion.

## 4. MCP security scanner

**Proposed route:** `/mcp-security-scanner`

**Search intent:** Product evaluation. The searcher wants to scan an MCP server
package, manifest, or live session and needs clarity on connect-time versus
runtime coverage.

**Recommended title:** MCP Security Scanner for Packages, Manifests, and Tool Calls

**Meta description:** Vet an MCP server package before connection, audit its tool
manifest, pin approved capabilities, and gate stdio calls—with explicit limits
and calibration scope.

**Page outline:**

1. Divide “MCP scanning” into package bytes, connect-time manifest, and live
   session; no single check covers all three.
2. Lead with package-scan-first using `pkgxray mcp --package …` so static
   analysis precedes stdio server execution.
3. Explain the read-only handshake and `tools/list` audit: descriptions,
   instructions, concealed text, and capability-surface mismatch.
4. Cover pin/recheck for manifest drift and the stdio `mcp-proxy` for tool
   listing changes, denied calls, and result-text injection scans.
5. Be explicit that enumerating a stdio server runs it in a constrained
   environment; HTTP servers are connect-time vetted but not wrapped by the
   current proxy.
6. Explain policy modes and why tool description analysis cannot prove benign
   implementation behavior.
7. Publish the MCP calibration warning prominently: the 300-package hunting
   list is outside the zero-false-block claim and exposed calibration debt.

**Questions to answer:**

- What parts of an MCP server can pkgxray scan?
- Does MCP manifest auditing execute the server?
- How does package-scan-first reduce risk?
- Can the scanner detect a tool manifest that changes after approval?
- Does the proxy protect HTTP MCP servers?
- How reliable are MCP verdicts compared with mainstream npm-package results?

**Internal links:**

- Existing `/` — MCP surface summary
- Existing `/stats` — aggregate run context
- Existing `/stats/methodology` — separation of top-1,000 and MCP target lists
- Proposed `/mcp-server-security` — operational hardening guide
- Proposed `/ai-coding-agent-security` — host and agent control layer

**Claims requiring citations:**

- MCP protocol handshake, tool listing, and change notifications: cite the
  current official MCP specification.
- Exact pkgxray command, environment scrubbing, timeout, proxy transport, and
  measured overhead: cite versioned implementation docs/tests and measurement
  conditions.
- Any ecosystem-size, authentication, or exposed-server statistic: cite its
  dated primary study and do not blend incomparable directory counts.
- MCP false-positive/calibration statements: cite benchmark methodology and
  clearly distinguish the hunting list from the top-1,000 denominator.

**CTA:** Scan the server package first, then audit and pin its live manifest;
use the stdio proxy only as one layer in a least-privilege MCP deployment.

## 5. MCP server security

**Proposed route:** `/mcp-server-security`

**Search intent:** Defensive guidance for builders and operators. The searcher
wants an MCP threat model and deployment checklist, not merely a scanner.

**Recommended title:** MCP Server Security: Threat Model and Deployment Checklist

**Meta description:** Secure MCP servers across package intake, credentials,
tool scopes, manifest drift, untrusted outputs, transport, and runtime
containment—with scanner limits made explicit.

**Page outline:**

1. Draw the trust boundaries: host/agent, server process, package supply chain,
   credentials, tool backends, and untrusted tool results.
2. Threat-model package compromise separately from malicious tool design,
   overbroad schemas, manifest rug-pulls, prompt injection in results, and
   exposed network endpoints.
3. Present a pre-connection checklist: pin package/version, static-scan package,
   inspect declared tools and instructions, minimize credentials, then pin the
   approved manifest.
4. Present runtime controls: process isolation, egress limits, per-tool
   authorization, result treatment, manifest-change handling, logging, and
   credential rotation.
5. Place pkgxray accurately: connect-time manifest audit and stdio proxy are
   controls, not proof of server implementation safety or authorization quality.
6. Separate stdio and HTTP deployment guidance; call out that pkgxray's proxy is
   stdio-only.
7. Add incident response for unexpected tools, changed schemas, leaked secrets,
   and compromised package releases.

**Questions to answer:**

- What are the main MCP server security risks?
- How should MCP credentials be scoped and stored?
- What is a tool-manifest rug-pull?
- Can prompt injection arrive in an MCP tool result?
- What changes between securing stdio and HTTP MCP servers?
- Which checks require runtime isolation beyond static scanning?

**Internal links:**

- Existing `/` — pkgxray's package and MCP entry points
- Existing `/stats/methodology` — evidence and calibration boundaries
- Proposed `/mcp-security-scanner` — pkgxray command and coverage detail
- Proposed `/ai-coding-agent-security` — permissions at the consuming-agent layer
- Proposed `/package-prompt-injection-detection` — content-delivery signals

**Claims requiring citations:**

- Protocol concepts and transport behavior: cite current official MCP
  specifications and security guidance.
- Public exposure, OAuth adoption, source availability, or MCP CVE counts: cite
  primary datasets/advisories, with dates and definitions.
- Runtime proxy behavior and restrictions: cite the current pkgxray MCP guide
  and tests.
- Avoid presenting the MCP hunting-list verdict distribution as prevalence;
  calibration data is not an epidemiological sample.

**CTA:** Use the checklist to constrain the server before connection, then add
package scanning, manifest pinning, and runtime authorization where applicable.

## 6. AI coding-agent security

**Proposed route:** `/ai-coding-agent-security`

**Search intent:** Broad security architecture intent. Engineering and security
teams want to control agents that can install dependencies, read repositories,
access credentials, and invoke MCP tools.

**Recommended title:** AI Coding-Agent Security for Packages and MCP Tools

**Meta description:** Reduce coding-agent supply-chain risk with install gates,
package quarantine, MCP manifest controls, least privilege, and evidence-based
review—without claiming complete safety.

**Page outline:**

1. Inventory the agent's effective capabilities: filesystem, shell, package
   manager, secrets, network, source control, and MCP tools.
2. Explain the two intake paths covered by pkgxray: packages installed and MCP
   servers connected.
3. Design a package-install gate: intercept requested installs, pin versions,
   quarantine and scan, and require policy-based promotion.
4. Design an MCP gate: package-scan-first, inspect and pin manifests, constrain
   credentials, and handle runtime tool/result drift.
5. Explain package-borne prompt injection as one input-control problem; a
   deterministic scanner reduces exposure but cannot secure the agent's own
   reasoning or permissions.
6. Add operational controls: least privilege, isolated workspaces, network
   policy, human approval for sensitive actions, logs, and dependency rechecks.
7. Provide a rollout maturity model from visibility to enforcement, with
   fail-closed scan errors and measured exception handling.

**Questions to answer:**

- What makes coding agents different from ordinary developer tooling?
- How can a team stop an agent from installing an unreviewed package?
- How should MCP tools be approved and monitored?
- Can deterministic scanning neutralize prompt injection?
- Which controls remain necessary after a package receives a safe verdict?

**Internal links:**

- Existing `/` — product surfaces and guard command
- Existing `/stats` — current aggregate calibration
- Existing `/stats/methodology` — limits of the measurements
- Proposed `/scan-npm-package-before-installing` — package intake procedure
- Proposed `/mcp-server-security` — MCP deployment controls
- Proposed `/package-prompt-injection-detection` — injection-specific limits

**Claims requiring citations:**

- Claims about agent adoption, speed, autonomy, or incident frequency: use
  current primary surveys or vendor documentation, not unsourced generalization.
- Supported hook/agent integrations: cite the current integration repository
  docs and test the named products before publication.
- Deterministic-verdict and prompt-injection claims: cite architecture and threat
  model; say the scanner's verdict path cannot be steered by scanned text, not
  that the consuming agent is injection-proof.
- Calibration figures retain the npm top-1,000 scope and cannot substantiate
  agent-wide safety.

**CTA:** Put a reviewable install gate in front of the agent first, then reduce
its filesystem, credential, network, and MCP permissions.

## 7. package prompt-injection detection

**Proposed route:** `/package-prompt-injection-detection`

**Search intent:** Technical informational intent. The searcher is investigating
instructions hidden in package documentation, comments, metadata, or encoded
text that may be consumed by an AI agent.

**Recommended title:** Package Prompt-Injection Detection for AI Coding Agents

**Meta description:** Detect prompt-injection delivery signals in package docs,
comments, and metadata—including concealed Unicode and encoded envelopes—while
preserving honest limits.

**Page outline:**

1. Define package-borne prompt injection and distinguish it from malicious code
   execution.
2. Map ingestion surfaces: README/docs, code comments, package metadata, and MCP
   descriptions/instructions/results.
3. Explain detector tiers: explicit rule-overriding text, weaker steering and
   role scaffolding, Unicode tag-block smuggling, Trojan Source characters, and
   base64 envelopes.
4. Explain why pkgxray's deterministic verdict path matters: scanned text is
   evidence, not instructions to an LLM adjudicator.
5. Show context-sensitive severity and why documentation is not scanned as if
   it were executable code.
6. State the unsolved parts: semantic paraphrase, images/unsupported formats,
   delayed or remote content, and the consuming agent's own susceptibility.
7. Recommend layered controls: quarantine untrusted context, provenance and
   source review, least privilege, output boundaries, and human approval.

**Questions to answer:**

- Can an npm README contain prompt injection?
- How can Unicode or base64 conceal instructions?
- Does pkgxray use an LLM to decide the verdict?
- What is the difference between detection and prevention?
- Can a clean scan prove that content will not manipulate an agent?

**Internal links:**

- Existing `/` — product overview and interactive verdicts
- Existing `/stats/methodology` — evidence and benchmark method
- Proposed `/ai-coding-agent-security` — permissions and agent-layer controls
- Proposed `/mcp-server-security` — injection in MCP manifests and results
- Proposed `/malicious-npm-package-detection` — code-behavior signals

**Claims requiring citations:**

- Unicode control-character behavior: cite Unicode specifications/security
  guidance and the relevant detector implementation.
- Prompt-injection taxonomy or impact claims: cite peer-reviewed or primary
  security research with the tested model/context.
- pkgxray detector coverage and severity: cite versioned tests and severity
  policy; do not extrapolate fixtures into a universal detection rate.
- “Injection-proof by construction” must be limited to pkgxray's deterministic
  verdict computation, never the package consumer or surrounding agent.

**CTA:** Scan package text before exposing it to an agent, then restrict what
the agent can do if manipulated.

## 8. npm package provenance verification

**Proposed route:** `/npm-package-provenance-verification`

**Search intent:** Technical comparison and implementation intent. The searcher
wants to validate where an npm artifact came from and may assume every tool that
shows SLSA metadata performs cryptographic verification.

**Recommended title:** npm Package Provenance Verification: Claims, Checks, and Limits

**Meta description:** Understand npm/SLSA provenance, cryptographic Sigstore
verification, artifact binding, and pkgxray's narrower parser-only repository
cross-check.

**Page outline:**

1. Separate four concepts: attestation presence, SLSA statement parsing,
   cryptographic identity/transparency verification, and subject-digest binding.
2. Explain what npm provenance is intended to record: build source, workflow,
   builder, and artifact subject.
3. Document full verification requirements at a high level: DSSE signature,
   Fulcio identity chain, Rekor inclusion/transparency evidence, policy checks,
   and digest binding to the downloaded artifact.
4. Describe pkgxray's actual implementation precisely: fetch registry
   attestations, decode SLSA v1/v0.2 payloads, read self-reported fields, and
   compare the claimed GitHub repository with `package.json`.
5. State what it does not do: no signature, Fulcio, Rekor-proof, or current
   guard-path tarball binding verification; a hand-crafted claim can be parsed.
6. Explain the non-offsetting rule: parsed provenance is INFO; mismatch can
   increase scrutiny, but a match cannot neutralize conduct findings or prove
   benign code.
7. Compare when to use `npm audit signatures` or a dedicated Sigstore verifier
   alongside pkgxray's behavior and artifact checks.

**Questions to answer:**

- What does npm provenance prove when fully verified?
- Is reading a SLSA attestation the same as verifying it?
- Does pkgxray cryptographically verify Sigstore provenance?
- Does pkgxray bind the attestation subject to the downloaded tarball?
- Can valid provenance accompany a compromised build?
- How should provenance interact with malware findings?

**Internal links:**

- Existing `/` — product overview; copy must not repeat its shorthand
  “verification” table without this qualification
- Existing `/stats/methodology` — calibration method, which is separate from
  provenance cryptography
- Proposed `/npm-supply-chain-security` — placement in a layered program
- Proposed `/malicious-npm-package-detection` — behavior remains independently
  relevant

**Claims requiring citations:**

- Sigstore, Fulcio, Rekor, DSSE, in-toto, and SLSA semantics: cite official
  Sigstore, in-toto, SLSA, and npm documentation for the current formats.
- Every statement about pkgxray's parser-only behavior: cite `src/attestation.js`
  and the changelog entry that explicitly excludes full cryptographic
  verification, tied to the released version.
- Any comparison with `npm audit signatures`: verify the current npm CLI
  behavior and trust policy from official docs.
- Do not cite the README shorthand comparison table alone; it currently says
  “verification” more broadly than the implementation supports.

**CTA:** Use a cryptographic verifier for authenticity and artifact binding,
then use pkgxray for repository-claim comparison and independent static conduct
signals.

## 9. malicious npm package detection

**Proposed route:** `/malicious-npm-package-detection`

**Search intent:** Deep technical investigation. The searcher wants to know
which malicious-package behaviors are detectable, how findings are correlated,
and where evasion remains possible.

**Recommended title:** Malicious npm Package Detection: Signals, Correlation, and Gaps

**Meta description:** See how static npm analysis correlates credential access,
network sinks, loaders, persistence, obfuscation, artifact drift, and injection
without promising complete detection.

**Page outline:**

1. Build an attack-path model: initial package, lifecycle trigger, collection,
   execution, persistence, command-and-control, and exfiltration.
2. Explain high-confidence correlation rather than keyword matching:
   credential reads near filesystem primitives, environment harvest near a
   network sink, encoded payload decode-to-execute, and cross-file stage-2 flow.
3. Cover supply-chain context: OSV findings, install scripts, metadata gaps,
   npm-to-GitHub divergence, and parsed provenance mismatch.
4. Explain calibration choices that avoid shallow false positives: comments are
   not conduct, minification is not obfuscation, test/example paths are treated
   differently, and weaker signals route to review.
5. Walk through evidence-citing findings and human triage.
6. Present measured outcomes correctly: top-1,000 heuristic false blocks versus
   known-malware reconstructed-corpus recall.
7. Detail evasion and coverage gaps: clean downloader stubs, remote/later-stage
   payloads, environment-gated behavior, unsupported semantics, and runtime-only
   actions.

**Questions to answer:**

- What behaviors indicate a malicious npm package?
- How does correlation reduce false alarms?
- Is minified or obfuscated code automatically malicious?
- Can pkgxray detect cross-file exfiltration or stage-2 loaders?
- Why might known malware receive review rather than block?
- What can static analysis miss?

**Internal links:**

- Existing `/` — product demo and verdict model
- Existing `/stats` — latest aggregate figures
- Existing `/stats/methodology` — corpus construction and adjudication
- Proposed `/npm-malware-scanner` — tool-selection overview
- Proposed `/package-prompt-injection-detection` — non-code content channel
- Proposed `/npm-package-provenance-verification` — trust-claim limits

**Claims requiring citations:**

- Detector behavior and severity: cite versioned source, tests, and severity
  policy; avoid claiming detection for variants not represented by logic/tests.
- Malware case-study behavior: cite advisories or primary incident analyses,
  and label reconstructed samples as models rather than recovered originals.
- Calibration results: cite dated aggregate pages and distinguish block recall,
  review routing, and “0 passed safe.”
- Static-analysis blind spots: cite the threat model and avoid suggesting the
  optional canary closes them.

**CTA:** Use the cited finding as the start of triage, not the end: inspect the
quarantined package, compare versions and source, and retain runtime controls.

## Editorial anti-cannibalization map

| Target | Own this primary question | Must not become |
|---|---|---|
| npm malware scanner | “Which scanner analyzes npm package behavior before install?” | A broad supply-chain program or detector encyclopedia |
| npm supply-chain security | “How do I design layered npm dependency controls?” | A single-command tutorial |
| scan npm package before installing | “What exact steps do I run before this install?” | A market comparison or threat-research essay |
| MCP security scanner | “What can this MCP scanner inspect at package, manifest, and session layers?” | A general MCP deployment checklist |
| MCP server security | “How do I threat-model and operate an MCP server safely?” | A pkgxray product page |
| AI coding-agent security | “How do I constrain an agent across installs, secrets, shell, network, and MCP?” | A prompt-injection-only page |
| package prompt-injection detection | “How are hostile instructions delivered and detected in package content?” | A general malicious-code detector page |
| npm package provenance verification | “What is cryptographically verified versus merely parsed or compared?” | A broad malware-scanning page |
| malicious npm package detection | “Which behavioral signals and correlations detect malicious packages?” | A tool-category landing page |

Editorial rules:

1. Give each page one exact-match H1 and one primary job from the table. Use
   synonyms in supporting copy, not competing H1s.
2. The task page owns the guard command walkthrough. Other npm pages may show
   one command but should link to it for procedural detail.
3. The provenance page owns the Sigstore/Fulcio/Rekor explanation. Other pages
   get one calibrated sentence and a link.
4. The prompt-injection page owns delivery-mechanism detail. Agent and MCP pages
   discuss permissions and context boundaries, then link to it.
5. The MCP scanner page owns pkgxray feature evaluation. The MCP server page
   must remain vendor-neutral enough to satisfy defensive informational intent.
6. The malicious-detection page owns detector correlation and evasion. The
   malware-scanner page owns category comparison and purchase/evaluation intent.
7. Use canonical tags only after routes exist. Do not canonicalize distinct
   intents to one umbrella page merely because terms overlap.
8. Link sibling pages with descriptive anchors, but avoid repeating the same
   title, meta description, opening definition, or full verdict explanation.

## Technical citation policy

1. **Prefer primary, current sources.** Use official npm, OpenSSF/OSV, Sigstore,
   SLSA, in-toto, Unicode, and MCP specifications; use original incident
   advisories or research datasets before commentary.
2. **Version product claims.** Cite a pkgxray release, commit, test, or dated
   calibration run. Features and detector behavior can change.
3. **Put a citation next to every number.** Include date, denominator, sample
   construction, and whether the figure counts packages, versions/releases,
   downloads, findings, or servers.
4. **Keep measured populations separate.** Never combine the top-1,000 npm
   calibration set, 300-package MCP hunting list, and reconstructed
   known-malware corpus into one accuracy or prevalence claim.
5. **Describe the metric exactly.** “0 heuristic false blocks on 1,000” is not
   “0 false positives.” “19 of 20 blocked and 0 safe” is not 100% block recall.
6. **Do not infer prevalence from scanner output.** Hunting-list findings and
   benchmark fixtures do not estimate the share of npm or MCP that is malicious.
7. **Separate capability from guarantee.** “Detects a tested pattern” is
   acceptable when tied to tests; “detects credential theft” needs scope and
   must not imply all implementations or evasions are covered.
8. **Treat trust signals as non-offsetting.** Source parity and parsed provenance
   add context. Neither establishes harmlessness, and parsed provenance is not
   cryptographic verification.
9. **Name execution boundaries.** `guard` is static and does not execute target
   code; stdio MCP enumeration does run the server under constraints; canary is
   explicitly opt-in dynamic observation.
10. **Preserve corrections.** Link the retuned run and methodology when quoting
    current calibration, while retaining the immutable earlier run as history.
11. **Avoid stale host assumptions.** Verify the production custom domain and
    canonical URLs before publishing. Until then, use route paths in briefs and
    do not assert that a proposed `pkgxray.ca` URL exists.
12. **No safety absolutes.** Ban “guarantees safety,” “proves safe,” “catches all
    malware,” “eliminates prompt injection,” and unscoped “zero false
    positives.” Prefer “found no gated indicators in the examined evidence,”
    “reduces exposure,” and “routes this tested pattern to review/block.”
