# 12-week technical content calendar

Publishing rule: each week has exactly one substantial technical post and two
smaller posts. Use educational, challengeable language; never publish a
package-verdict oracle or an uncoordinated finding. Advisory fixtures are
reconstructed minimal examples, not original incident artifacts.

## Week 1 — Beyond CVE-only scanning

### 1. Substantial — “The gap after the CVE lookup”
- **Intended audience:** AppSec engineers and dependency-platform teams.
- **Thesis:** Known-vulnerability lookup is essential, but a fresh trojan may have no advisory; pre-install behavioral and trust signals cover a different gap.
- **Outline:** OSV pre-check → no-CVE attack window → static conduct/trust checks → layered workflow with npm audit/OSV-Scanner.
- **Supporting repository evidence:** `README.md` lines 63–69 says OSV runs before download and separately checks code behavior, artifact/source parity, provenance consistency, and docs; `README.md` lines 205–225 explicitly positions pkgxray alongside, not as a replacement for, npm audit and OSV-Scanner.
- **Suggested visual:** Two overlapping lanes: “known vulnerability” and “new supply-chain behavior.”
- **CTA:** Run `pkgxray guard npm:<name>@<version>` beside the existing CVE job and compare the questions each answers.
- **Risk of overclaiming:** Do not imply every novel attack is detectable; `docs/threat-model.md` lines 22–30 documents clean-tarball/runtime payload limits.

### 2. Small — “Why OSV runs before the tarball download”
- **Intended audience:** CI maintainers.
- **Thesis:** An already-known vulnerable version can be rejected without acquiring its package body.
- **Outline:** Resolve version → OSV batch check → block known vulnerability → fetch only if appropriate.
- **Supporting repository evidence:** `README.md` lines 91 and 231–235 says the OSV pre-check precedes fetch; `docs/reference.md` lines 100–112 says known-vulnerable packages block before download.
- **Suggested visual:** Four-box acquisition pipeline with the first box highlighted.
- **CTA:** Capture JSON output and inspect `vulnerabilityPrecheck`.
- **Risk of overclaiming:** “Before download” applies to the package tarball, not to all network requests.

### 3. Small — “One fixture, two security questions”
- **Intended audience:** Security-tool builders.
- **Thesis:** A labelled malicious sample should test both the expected verdict and, when useful, the expected finding category.
- **Outline:** `expect` → optional `expectFinding` → actual comparison → regression outcome.
- **Supporting repository evidence:** `benchmark/README.md` lines 60–73 defines those fields; `benchmark/corpus/malicious/known-vulnerability.json` is the corpus’s known-CVE case.
- **Suggested visual:** Annotated fixture JSON with two arrows.
- **CTA:** Add a minimal malicious/benign fixture pair for a detector you care about.
- **Risk of overclaiming:** A fixture validates a reduced shape, not all variants of a threat.

## Week 2 — Artifact to source

### 4. Substantial — “What shipped is not always what is tagged”
- **Intended audience:** Package maintainers, release engineers, and reviewers.
- **Thesis:** Comparing the npm artifact with tagged source exposes divergence, but divergence is evidence for review—not proof of tampering.
- **Outline:** Resolve repository/ref → compare source files → classify extras/mismatches → distinguish generated output from injected conduct.
- **Supporting repository evidence:** `README.md` lines 66–69 and 93 describe npm↔GitHub comparison; `docs/reference.md` lines 26–35 maps divergence to REVIEW; `benchmark/corpus/benign/npm-github-divergence.json` records one extra `dist/extra.js` among five npm files and expects REVIEW.
- **Suggested visual:** Side-by-side file trees with matched, changed, and artifact-only files.
- **CTA:** Inspect `npmVsGithubDiff` in a guard JSON report.
- **Risk of overclaiming:** Never label divergence alone malicious; build, rename, and retag workflows legitimately diverge.

### 5. Small — “Why generated bundles broke a naive parity rule”
- **Intended audience:** Static-analysis implementers.
- **Thesis:** Code-execution syntax inside artifact-only build output is common and cannot by itself establish artifact tampering.
- **Outline:** Divergent bundle → generic `new Function` → false block → require malicious conduct evidence.
- **Supporting repository evidence:** `CHANGELOG.md` lines 121–126 says Angular/Babel/requirejs-style artifacts triggered the old rule and now only genuine exfiltration, credential, or persistence conduct escalates; `benchmark/corpus/benign/build-artifact-divergent-eval.json` expects REVIEW.
- **Suggested visual:** “Primitive” versus “conduct” evidence scale.
- **CTA:** Review parity findings with source-map/build context.
- **Risk of overclaiming:** The recalibration reduces one false-positive class; it does not prove generated artifacts safe.

### 6. Small — “A 404 is ambiguity, not guilt”
- **Intended audience:** Open-source consumers.
- **Thesis:** A missing linked repository can mean abandonment or renaming as easily as deception.
- **Outline:** Repository lookup → 404 → competing explanations → human review.
- **Supporting repository evidence:** `CHANGELOG.md` lines 134–137 moves repository 404s to REVIEW; `benchmark/corpus/benign/github-repo-404-abandoned.json` models `optimist`’s renamed/deleted repository.
- **Suggested visual:** Forked path from one 404 signal to two explanations.
- **CTA:** Verify package history and ownership before drawing a conclusion.
- **Risk of overclaiming:** Do not present the modeled package as currently compromised.

## Week 3 — Provenance, precisely stated

### 7. Substantial — “What a provenance attestation can—and cannot—tell you”
- **Intended audience:** Release engineers and supply-chain architects.
- **Thesis:** Parsed provenance and subject/repository consistency are useful signals, but parsing is not cryptographic verification.
- **Outline:** Attestation claims → subject digest binding → repository consistency → non-offsetting policy → Sigstore/Fulcio/Rekor boundary.
- **Supporting repository evidence:** `README.md` lines 66–69 calls the check consistency; `CHANGELOG.md` lines 248–253 says pkgxray parses SLSA provenance but does not cryptographically verify it, adds digest binding, and forbids an attestation from moving a verdict toward safe.
- **Suggested visual:** Trust ladder with “parsed,” “bound,” and “cryptographically verified” separated.
- **CTA:** Ask security tools to state the exact verification step they perform.
- **Risk of overclaiming:** Never use “verified provenance” for pkgxray’s parsing path.

### 8. Small — “Why provenance cannot cancel conduct”
- **Intended audience:** Policy authors.
- **Thesis:** A positive provenance signal must not erase suspicious behavior in the shipped bytes.
- **Outline:** Attestation present → conduct finding remains → verdict cannot improve solely from attestation.
- **Supporting repository evidence:** `CHANGELOG.md` lines 248–253 defines the non-offsetting invariant; `CHANGELOG.md` lines 173–177 says conduct findings and OSV/install hooks do not receive the self-scan downgrade.
- **Suggested visual:** One-way ratchet labeled “provenance cannot move toward SAFE.”
- **CTA:** Test whether your own policy engine lets trust metadata cancel behavior.
- **Risk of overclaiming:** Non-offsetting policy is not cryptographic authenticity.

### 9. Small — “Releases should inspect their own packed artifact”
- **Intended audience:** npm maintainers.
- **Thesis:** Testing source is incomplete if publication ships a different archive.
- **Outline:** Tests → calibration benchmark → pack artifact → self-guard → provenance publish.
- **Supporting repository evidence:** `README.md` lines 276–280 says releases are gated on tests, benchmark, and a self supply-chain guard; `CHANGELOG.md` lines 159–161 describes guarding the packed artifact before npm publication with provenance.
- **Suggested visual:** Release pipeline with the packed tarball as the inspected object.
- **CTA:** Add an artifact-stage check after `npm pack`.
- **Risk of overclaiming:** A clean static self-scan is not a general proof of release integrity.

## Week 4 — Prompt injection is an input problem

### 10. Substantial — “Scanning package docs without letting docs steer the scanner”
- **Intended audience:** AI-agent security engineers.
- **Thesis:** Deterministic verdict logic makes package text unable to steer the verdict, while delivery-channel detectors can still identify concealed or imperative injection.
- **Outline:** Untrusted docs → deterministic verdict path → delivery-channel checks → REVIEW uncertainty → least-privilege consuming agent.
- **Supporting repository evidence:** `docs/threat-model.md` lines 48–63 defines three layers and explicitly says scanning does not solve prompt injection; `docs/reference.md` lines 13–35 maps verdict-forcing text to BLOCK and weaker steering to REVIEW; `README.md` lines 71–78 says no LLM is in the verdict path.
- **Suggested visual:** Untrusted README entering a deterministic rules box, then an agent capability boundary.
- **CTA:** Treat docs as untrusted input and pair scanning with agent capability controls.
- **Risk of overclaiming:** Say “reduces exposure,” never “solves prompt injection.”

### 11. Small — “Defensive docs can quote attack strings”
- **Intended audience:** Security documentation authors.
- **Thesis:** Context matters: a blocklist documenting phrases should not be treated as the attack it teaches users to reject.
- **Outline:** Same phrase → defensive marker nearby → INFO versus bare imperative → BLOCK.
- **Supporting repository evidence:** `benchmark/corpus/benign/injection-defense-blocklist-doc.json` expects SAFE when blocklist/sanitizer context is near the hit; it contrasts `injection-readme.json` and `injection-base64-doc.json`, which remain BLOCK.
- **Suggested visual:** Identical phrase in “sanitizer rules” and “instructions to agent” cards.
- **CTA:** Keep defensive purpose explicit and local to quoted examples.
- **Risk of overclaiming:** Context heuristics are calibration choices, not semantic understanding.

### 12. Small — “Why README files are not scanned as executable code”
- **Intended audience:** Detector designers.
- **Thesis:** Treating prose as JavaScript creates avoidable false positives; docs need a purpose-built injection path.
- **Outline:** README prose → injection-only checks → no conduct interpretation.
- **Supporting repository evidence:** `docs/threat-model.md` lines 32–43 states READMEs run only prompt-injection checks and docs are not scanned as code.
- **Suggested visual:** File-type router splitting docs and runtime source.
- **CTA:** Separate content-type policies in your scanner.
- **Risk of overclaiming:** Other code comments can still carry injection and receive dedicated checks.

## Week 5 — Unicode and Trojan Source

### 13. Substantial — “Invisible text, visible evidence”
- **Intended audience:** Secure-code reviewers and AI platform teams.
- **Thesis:** Unicode tag characters, bidi controls, and zero-width characters create distinct review problems; decoded verdict-forcing content can justify stronger action than an unexplained channel alone.
- **Outline:** Character classes → reveal/normalize → decode tags → classify payload → cite location.
- **Supporting repository evidence:** `README.md` lines 84–87 lists Unicode smuggling and Trojan Source; `docs/reference.md` lines 23–32 assigns concealed decoded injection to BLOCK while Trojan Source and unexplained tag characters route to REVIEW; `benchmark/corpus/malicious/advisory-ascii-smuggling-injection.json` expects BLOCK for an invisible verdict-forcing README payload.
- **Suggested visual:** Visible README beside a code-point/revealed-text panel.
- **CTA:** Render invisible code points during package review.
- **Risk of overclaiming:** Invisible characters alone are not proof of malicious intent.

### 14. Small — “Trojan Source and ASCII smuggling are not synonyms”
- **Intended audience:** Developer educators.
- **Thesis:** Bidi/zero-width source confusion and Unicode-tag hidden instructions use different channels and deserve different explanations.
- **Outline:** Bidi visual reorder → source-review risk; tag block → concealed text channel; severity follows content/context.
- **Supporting repository evidence:** `README.md` line 86 names both; `docs/reference.md` lines 23–32 separates decoded tag injection from Trojan Source and bare invisible tags.
- **Suggested visual:** Two-column taxonomy.
- **CTA:** Name the exact Unicode mechanism in findings.
- **Risk of overclaiming:** Avoid saying all zero-width characters are Trojan Source attacks.

### 15. Small — “A safe way to demo hidden injection”
- **Intended audience:** Conference speakers and maintainers.
- **Thesis:** Reconstructed fixtures teach detector behavior without redistributing live malicious packages.
- **Outline:** Minimal benign-looking README → hidden reconstructed payload → expected finding → no real target.
- **Supporting repository evidence:** `benchmark/README.md` lines 83–95 says advisory fixtures are reduced, modeled samples; `benchmark/corpus/malicious/advisory-ascii-smuggling-injection.json` uses package name `readme-clean` and a minimal README.
- **Suggested visual:** Fixture anatomy, with code points escaped.
- **CTA:** Reproduce with the committed fixture, not an incident artifact.
- **Risk of overclaiming:** Clearly label the sample reconstructed and do not attribute its exact bytes to an advisory.

## Week 6 — Credential access

### 16. Substantial — “A sensitive path is a clue; a read and sink make the case”
- **Intended audience:** Detection engineers.
- **Thesis:** Credential detection becomes more reliable when it distinguishes text mentions, filesystem reads, auth fields, and nearby exfiltration sinks.
- **Outline:** Sensitive path inventory → read primitive → de-obfuscate split path → network/dynamic-load correlation → test/fixture downgrade.
- **Supporting repository evidence:** `README.md` line 84 covers `.ssh`, `.aws`, `.npmrc`, `.env`, keychains, wallets, and split fragments; `docs/reference.md` lines 13–22 defines HIGH correlations; `benchmark/corpus/malicious/advisory-solana-web3-keytheft.json` reconstructs wallet-file reads posted to an endpoint.
- **Suggested visual:** Evidence ladder from string mention to read-plus-egress.
- **CTA:** Review the cited file and sink, not just the finding label.
- **Risk of overclaiming:** A sensitive filename in docs/tests is not credential theft.

### 17. Small — “The `.npmrc` false block that refreshed the benchmark”
- **Intended audience:** Security benchmark owners.
- **Thesis:** Reading `.npmrc` for the registry URL is not token theft when no auth field or network sink exists.
- **Outline:** Initial block → manual review → narrow rule → commit benign fixture → refresh list.
- **Supporting repository evidence:** `validation/README.md` lines 22–31 records `registry-url@7.2.0`, 100M+ weekly downloads, as the surfaced case and the INFO retune; `benchmark/corpus/benign/npmrc-read-for-registry-url.json` locks the distinction in.
- **Suggested visual:** Before/after decision tree for `.npmrc`.
- **CTA:** Turn every confirmed false block into a regression fixture.
- **Risk of overclaiming:** Do not generalize that all `.npmrc` reads are harmless; token references or egress remain high-risk.

### 18. Small — “Split strings do not erase sensitive paths”
- **Intended audience:** JavaScript security reviewers.
- **Thesis:** Light constant folding can recover paths such as `".s" + "sh"` without pretending to solve arbitrary obfuscation.
- **Outline:** Literal fragments → folded string → filesystem read → cited finding.
- **Supporting repository evidence:** `docs/reference.md` lines 13–16 names split-fragment folding; `CHANGELOG.md` lines 202–205 says large-file folding and static base64/`atob` decoding of literal credential paths were added.
- **Suggested visual:** String fragments joining into `.ssh`.
- **CTA:** Include simple de-obfuscation in static checks.
- **Risk of overclaiming:** This is bounded constant recovery, not full program analysis.

## Week 7 — Minification and false-positive calibration

### 19. Substantial — “Minification is not obfuscation”
- **Intended audience:** Frontend platform teams and scanner authors.
- **Thesis:** Packed-looking code is common; gating should rely on executable data flow such as nearby decode-to-computed-execution, not density or minification alone.
- **Outline:** Common bundle shapes → literal versus computed execution → proximity constraint → skipped generated file types → benign counterexamples.
- **Supporting repository evidence:** `README.md` line 90 states minification alone is not flagged; `docs/threat-model.md` lines 42–43 requires computed-argument eval; `docs/reference.md` lines 36–42 makes literal eval INFO and skips `.min.js`/maps; `benchmark/corpus/benign/bundle-decoder-far-from-eval.json` expects SAFE.
- **Suggested visual:** Bundle spectrum from minified to decode→execute data flow.
- **CTA:** Ask whether an “obfuscation” finding cites actual flow.
- **Risk of overclaiming:** Skipping `.min.js` is a coverage trade-off, not evidence minified files are safe.

### 20. Small — “Why 600 characters mattered”
- **Intended audience:** Heuristic maintainers.
- **Thesis:** Whole-file co-occurrence confused unrelated polyfills and compilers; local proximity better represented decode-to-execute intent.
- **Outline:** `atob` polyfill → distant `new Function` → old false block → ~600-character proximity.
- **Supporting repository evidence:** `CHANGELOG.md` lines 116–120 documents the pouchdb-shaped case and ~600-character requirement; `benchmark/corpus/benign/bundle-decoder-far-from-eval.json` preserves it.
- **Suggested visual:** Source strip with far-apart tokens versus adjacent chain.
- **CTA:** Measure locality when correlating dual-use primitives.
- **Risk of overclaiming:** Proximity is a heuristic and can miss nonlocal flows.

### 21. Small — “Precision and recall need named failure buckets”
- **Intended audience:** Security ML/static-analysis practitioners.
- **Thesis:** “Accuracy” hides costly outcomes; false blocks, misses, over-flags, and under-flags should be reported separately.
- **Outline:** Outcome matrix → hard failures → warnings → precision/recall trade-off.
- **Supporting repository evidence:** `benchmark/README.md` lines 15–46 defines CORRECT, FALSE_BLOCK, MISS, OVER_FLAG, UNDER_FLAG, XFAIL, and XPASS; false blocks and misses hard-fail.
- **Suggested visual:** Confusion matrix annotated with repository outcome names.
- **CTA:** Publish your benchmark’s adjudication rules, not one aggregate score.
- **Risk of overclaiming:** Corpus metrics do not automatically transfer to the whole registry.

## Week 8 — Lessons from widely used packages

### 22. Substantial — “What scanning 1,000 widely used packages changed”
- **Intended audience:** AppSec leads and tool evaluators.
- **Thesis:** At-scale benign scanning is detector development: it exposed false-block classes that curated malware samples could not.
- **Outline:** Fresh download ranking → 1,000 pinned targets → manual adjudication → 22 historical false blocks/~7 detectors → fixture feedback loop → current scoped result.
- **Supporting repository evidence:** `validation/README.md` lines 8–31 reports the fresh 2026-07-19 run and `.npmrc` fix; lines 86–94 records 22 false blocks across ~7 detectors from the earlier harness; `docs/benchmark.md` lines 62–76 reports 0 heuristic false blocks after retuning, three correct CVE blocks, and excludes the MCP ecosystem from the claim.
- **Suggested visual:** Loop: scan → adjudicate → narrow → fixture → CI.
- **CTA:** Re-run against a fresh popularity list and publish reproducibility inputs.
- **Risk of overclaiming:** State exactly “0 heuristic false blocks on the top-1000 most-downloaded packages,” not zero false positives everywhere.

### 23. Small — “Why popularity-list freshness is a security property”
- **Intended audience:** Benchmark maintainers.
- **Thesis:** A stale ranking can preserve a true-looking claim while never exercising today’s widely installed packages.
- **Outline:** 2019-ish depended-upon list → missing `registry-url` → fresh download-ranked list → surfaced false block.
- **Supporting repository evidence:** `docs/benchmark.md` lines 24–32 explains the stale-list gap; `validation/calibration-2026-07-19/README.md` lines 19–25 documents re-ranking ~2,600 candidates by last-week downloads and pinning 1,000 versions.
- **Suggested visual:** Old and fresh rank lists with one newly covered package.
- **CTA:** Date, pin, and publish benchmark inputs.
- **Risk of overclaiming:** Popularity coverage tests false blocks, not malicious-package recall.

### 24. Small — “Why per-package verdicts are not a public leaderboard”
- **Intended audience:** Security researchers and community managers.
- **Thesis:** Aggregate calibration can be reproducible without publishing a free package-to-verdict detection oracle.
- **Outline:** Publish pinned targets/method → let others reproduce → withhold per-package verdict map → coordinate real findings.
- **Supporting repository evidence:** `validation/calibration-2026-07-19/README.md` lines 3–7 says inputs contain names/versions only and explicitly rejects a public verdict oracle; lines 49–52 limits publication to aggregate calibration.
- **Suggested visual:** Open inputs and method, closed verdict lookup.
- **CTA:** Reproduce the aggregate run locally and disclose findings responsibly.
- **Risk of overclaiming:** Withholding verdicts does not itself prevent evasion; it raises the cost of oracle access.

## Week 9 — Install scripts mean REVIEW

### 25. Substantial — “Why lifecycle scripts stop at REVIEW”
- **Intended audience:** Package consumers and policy owners.
- **Thesis:** Install scripts execute at a privileged moment, but many are legitimate; presence alone merits human review while stronger conduct signals can block.
- **Outline:** Lifecycle timing → legitimate native/setup uses → REVIEW baseline → combine HTTP/IP/fetch/exec or credential behavior → BLOCK → quarantine workflow.
- **Supporting repository evidence:** `docs/reference.md` lines 26–35 maps install/postinstall scripts to REVIEW; `benchmark/corpus/benign/postinstall-ci-detect.json` expects REVIEW for a CI-aware script with no egress; `benchmark/corpus/malicious/insecure-http-postinstall-fetch-exec.json` expects BLOCK for plaintext-IP fetch, extract, chmod, and execute.
- **Suggested visual:** Decision tree from lifecycle script to REVIEW or behavior-correlated BLOCK.
- **CTA:** Inspect lifecycle source in quarantine before promotion.
- **Risk of overclaiming:** Do not call every install script malware or imply REVIEW means safe.

### 26. Small — “REVIEW is a decision, not detector indecision”
- **Intended audience:** Developers adopting security gates.
- **Thesis:** REVIEW encodes incomplete evidence or privileged capability that needs human context.
- **Outline:** SAFE/BLOCK extremes → REVIEW purpose → exit code 3 → policy decision.
- **Supporting repository evidence:** `README.md` lines 125–135 defines REVIEW and stable exit code 3; `docs/reference.md` lines 26–35 enumerates medium-risk shapes.
- **Suggested visual:** Three-lane triage board.
- **CTA:** Define who owns REVIEW and what evidence they inspect.
- **Risk of overclaiming:** Allowing REVIEW by policy is an explicit loosening, not equivalent to SAFE.

### 27. Small — “Shell completion can look like persistence”
- **Intended audience:** CLI maintainers.
- **Thesis:** Appending completion code to a shell rc file deserves review but differs from silent boot persistence.
- **Outline:** Same destination → user-invoked completion context → REVIEW; cron/systemd/Run-key writes → BLOCK.
- **Supporting repository evidence:** `CHANGELOG.md` lines 107–110 records this calibration; `benchmark/corpus/benign/shell-completion-installer.json` expects REVIEW for `<tool> completion >> ~/.bashrc`.
- **Suggested visual:** Shell-rc completion versus system startup persistence.
- **CTA:** Make installer side effects explicit and user-invoked.
- **Risk of overclaiming:** Shell-rc writes can still be malicious when they carry executable/download payloads.

## Week 10 — MCP capability boundaries

### 28. Substantial — “When a tool schema exceeds its stated purpose”
- **Intended audience:** MCP server authors and agent-platform teams.
- **Thesis:** A capability-surface mismatch—such as `get_weather` accepting `command`—is a reviewable manifest risk, while connect-time inspection cannot prove later runtime behavior.
- **Outline:** Read-only handshake → tool description/schema → purpose/capability comparison → prompt/Unicode checks → pin fingerprint → runtime boundary.
- **Supporting repository evidence:** `docs/mcp.md` lines 34–68 says `pkgxray mcp` only lists tools and gives the mismatch example; lines 62–68 documents that stdio enumeration executes the server and recommends package-scan first; `README.md` lines 94–95 separates manifest mismatch from runtime drift.
- **Suggested visual:** Tool description and schema side-by-side, with excess parameters highlighted.
- **CTA:** Audit and pin manifests before connecting.
- **Risk of overclaiming:** A clean manifest does not prove calls are safe; package behavior and later runtime drift remain separate stages.

### 29. Small — “The MCP ecosystem is outside the zero-false-block claim”
- **Intended audience:** MCP adopters and evaluators.
- **Thesis:** Current heuristics over-block some MCP/agent-tooling packages, so the top-1000 calibration claim must not be extended to that niche ecosystem.
- **Outline:** Top-1000 denominator → separate 300-package MCP scan → known calibration debt → per-case reconciliation.
- **Supporting repository evidence:** `docs/benchmark.md` lines 7–22 and 74–76 explicitly excludes the 300 MCP-package scan; cited causes include shipped `.mcp.json`, config reads, process spawning, and defensive injection docs.
- **Suggested visual:** Two non-overlapping benchmark cohorts.
- **CTA:** Treat MCP package blocks as evidence to review and report false positives with minimal fixtures.
- **Risk of overclaiming:** Never market “zero false blocks” without the most-downloaded-package scope.

### 30. Small — “A package shipping `.mcp.json` is not automatically malicious”
- **Intended audience:** MCP package maintainers.
- **Thesis:** A self-manifest using a package launcher merits review, while raw shells, paths, and shell metacharacters remain stronger signals.
- **Outline:** Parse manifest command → package launcher/self → REVIEW; shell/interpreter/metacharacters → BLOCK.
- **Supporting repository evidence:** `benchmark/corpus/benign/mcp-server-ships-own-manifest.json` documents the retune and expects REVIEW.
- **Suggested visual:** Manifest-command decision table.
- **CTA:** Keep MCP launcher configuration narrow and auditable.
- **Risk of overclaiming:** REVIEW does not certify the declared server or its runtime conduct.

## Week 11 — Runtime drift and sandbox complements

### 31. Substantial — “Connect-time trust expires”
- **Intended audience:** Agent-runtime architects.
- **Thesis:** A pinned manifest addresses approval-time identity, but live sessions need a later-stage gate for `tools/list_changed`, unknown tools, drifted fingerprints, and poisoned results.
- **Outline:** Connect-time audit → pin → live proxy → hold calls during relist → strip/deny tools → scan bounded outputs → HTTP limitation.
- **Supporting repository evidence:** `docs/mcp.md` lines 70–105 describes the stdio proxy: first-list audit, ~0.05 µs lookup, held calls during re-audit, 512 KiB result scan, and denial of drifted tools; HTTP servers are not wrapped.
- **Suggested visual:** Timeline from approval through manifest change to denied call.
- **CTA:** Wrap stdio servers with `mcp-proxy`; use pin/recheck for HTTP.
- **Risk of overclaiming:** The proxy is later-stage protection, not a full sandbox, and it does not wrap HTTP servers.

### 32. Small — “What `tools/list_changed` should trigger”
- **Intended audience:** MCP host implementers.
- **Thesis:** A change notification should pause relevant calls until the fresh manifest is re-listed and re-audited.
- **Outline:** Notification → hold → relist → audit → decide using fresh verdict.
- **Supporting repository evidence:** `docs/mcp.md` lines 90–101 says mid-verification calls are held and unknown/blocked tools are denied.
- **Suggested visual:** Sequence diagram with a held call.
- **CTA:** Test a manifest rug-pull in a controlled local server.
- **Risk of overclaiming:** This covers declared tool drift, not arbitrary malicious behavior inside an allowed implementation.

### 33. Small — “Static inspection and runtime sandboxing answer different questions”
- **Intended audience:** Security architects.
- **Thesis:** Static scanning sees shipped bytes before execution; runtime confinement observes/limits later behavior, including payloads fetched after install.
- **Outline:** Clean tarball blind spot → capability hint → runtime sandbox → canary can confirm but never clear.
- **Supporting repository evidence:** `docs/threat-model.md` lines 22–30 states the clean-tree blind spot and sandbox complement; `CHANGELOG.md` lines 68–73 renames quiet canary results to `not-observed`, never `safe`.
- **Suggested visual:** Pre-install static layer followed by runtime sandbox layer.
- **CTA:** Pair static gating with runtime confinement where dynamic loaders matter.
- **Risk of overclaiming:** One quiet detonation does not establish safety; environment-aware malware may stay dormant.

## Week 12 — Reproducible, challengeable security tools

### 34. Substantial — “How to make a security claim someone else can challenge”
- **Intended audience:** Security-tool maintainers, evaluators, and researchers.
- **Thesis:** A credible claim needs scoped wording, pinned inputs, executable method, labelled reduced fixtures, visible exceptions, and CI gates.
- **Outline:** State denominator → publish names/versions → define adjudication → run real engine/no execution → expose XFAIL/under-flags → gate false blocks/misses → refresh.
- **Supporting repository evidence:** `docs/benchmark.md` lines 3–32 scopes and dates the claim; `benchmark/README.md` lines 15–51 defines outcomes including visible XFAIL/under-flags; `validation/calibration-2026-07-19/README.md` lines 9–47 publishes pinned inputs and reproduction command without per-package verdicts.
- **Suggested visual:** “Claim card” containing scope, date, corpus, command, and failure policy.
- **CTA:** Re-run `npm run benchmark` and challenge a label with a smaller counterexample.
- **Risk of overclaiming:** Reproducibility does not make labels infallible; manual adjudication and corpus coverage remain contestable.

### 35. Small — “Under-flags belong in the report”
- **Intended audience:** Benchmark reviewers.
- **Thesis:** Relabeling a malicious sample to match a cautious policy hides the detector’s edge; report the under-classification instead.
- **Outline:** Ground-truth BLOCK → actual REVIEW → UNDER_FLAG warning → policy discussion.
- **Supporting repository evidence:** `benchmark/README.md` lines 48–51 uses bare `curl | sh` as the example; lines 97–101 also documents the policy boundary for reconstructed advisory samples.
- **Suggested visual:** Expected/actual verdict mismatch card.
- **CTA:** Preserve security-correct labels even when policy intentionally routes to humans.
- **Risk of overclaiming:** An under-flag is not a full miss; the tool still surfaced the sample.

### 36. Small — “The claim we can keep honest”
- **Intended audience:** Project users and journalists.
- **Thesis:** The defensible sentence is dated and bounded: zero heuristic false blocks on the fresh top-1000 most-downloaded npm packages after retuning—not zero false positives everywhere.
- **Outline:** Exact claim → 2026-07-19 run → three OSV blocks separated → MCP boundary → future regression gate.
- **Supporting repository evidence:** `docs/benchmark.md` lines 7–22 gives the approved and rejected formulations; lines 64–76 reports 1,000 packages, three correct known-CVE blocks, and the excluded MCP cohort.
- **Suggested visual:** Green scoped claim box beside a crossed-out universal claim.
- **CTA:** Link directly to the scope and reproducibility inputs whenever quoting the number.
- **Risk of overclaiming:** Do not omit “heuristic,” “top-1000 most-downloaded,” the date, or the MCP over-blocking boundary.
