# Recurring technical series

## Editorial contract

Every series is educational, evidence-first, and transparent about uncertainty.
Show enough repository evidence for a reader to reproduce or challenge the
lesson, but never publish a package-verdict oracle or an uncoordinated finding.
Use advisory fixtures only as **reconstructed, reduced samples modeled on public
incidents**; never imply they are original malicious artifacts
(`benchmark/README.md`, “Real-world advisory samples”).

When calibration appears, use the exact claim: **0 heuristic false blocks on
the top-1000 most-downloaded npm packages in the 2026-07-19 revalidation, after
the surfaced false block was retuned**. Do not turn that into “zero false
positives in the wild.” `docs/benchmark.md` explicitly excludes the newer
300-package MCP/agent-tooling scan, where heuristics over-block and calibration
debt is being reconciled per case. Connect-time MCP manifest review is also not
a runtime guarantee: `docs/mcp.md` requires the later-stage `mcp-proxy` for
stdio manifest drift and result scanning, while HTTP servers only have
connect-time pin/recheck.

Shared disclosure and safety guardrails:

- Coordinate a potentially novel package finding privately under the relevant
  security policy; do not name a package before coordination or resolution.
- Do not provide a searchable package-to-verdict table, API, or recurring
  leaderboard. The reproducibility publication intentionally contains pinned
  targets and method, not verdicts
  (`validation/calibration-2026-07-19/README.md`).
- Prefer synthetic examples, committed benign fixtures, or already-public
  advisories. Mark reconstructed advisory fixtures on-screen and in captions.
- Quote the file path, reduced evidence, expected verdict, actual verdict, and
  policy reason where safe. Separate observation from inference.
- Never equate `SAFE` with proof of harmlessness, `REVIEW` with guilt, a clean
  canary run with safety, provenance parsing with cryptographic verification,
  or artifact divergence with tampering.
- Remove live credentials, tokens, attacker infrastructure, weaponizable
  payloads, and personal data. Use RFC 5737 IPs and clearly fictional domains.

## 1. Package X-Ray of the Week

**Purpose and tone:** Teach one supply-chain review technique through a
consented maintainer walkthrough, a benign fixture, or a reconstructed public
incident. Curious and precise, never a verdict spectacle.

**Reusable template**

> **Package X-Ray of the Week: [review technique]**  
> **Artifact:** [fixture / maintainer-approved package / public advisory]  
> **Question:** [one narrow security question]  
> **Evidence:** `[path]` — [precise, reproducible fact]  
> **What the tool reports:** [finding + verdict tier]  
> **Reviewer interpretation:** [benign explanation / risk / uncertainty]  
> **Boundary:** [what this scan cannot establish]  
> **Reproduce:** [safe local command or fixture path]  
> **Takeaway:** [one transferable review habit]

**Required fields/checklist**

- [ ] Publication basis and permission/public-advisory status
- [ ] Package/version or fixture commit pinned
- [ ] Exact evidence path and non-sensitive excerpt
- [ ] Tool output separated from human interpretation
- [ ] Competing benign explanation considered
- [ ] Static/runtime and CVE/heuristic boundaries named
- [ ] No live verdict lookup, pile-on language, or uncoordinated allegation
- [ ] CTA asks readers to reproduce the technique, not trust a verdict

**Example-safe topic:** Use
`benchmark/corpus/benign/npm-github-divergence.json`: one artifact-only
`dist/extra.js`, four matched files, expected REVIEW. Explain that
`docs/reference.md` places npm↔GitHub divergence in REVIEW because generated
build output and retags are legitimate possibilities.

## 2. Would pkgxray catch this?

**Purpose and tone:** Turn a reconstructed threat shape into a falsifiable test.
Lead with “let’s run the fixture,” not with a promise that the whole attack
family is solved.

**Reusable template**

> **Would pkgxray catch this? [threat shape]**  
> **Source:** [public advisory being modeled]  
> **Reconstruction notice:** This is a minimal reconstructed fixture, not the
> original incident package.  
> **Ground-truth label:** [SAFE / REVIEW / BLOCK and why]  
> **Expected finding:** [category, if specified]  
> **Minimal evidence:** `[fixture path]` — [behavior]  
> **Actual result:** [verdict/finding or documented under-flag]  
> **Why:** [detector and severity-policy boundary]  
> **Nearby miss/false-positive trap:** [benign counterpart]  
> **Limit:** [variant or runtime behavior not covered]  
> **Reproduce:** `npm run benchmark -- [if supported]` or
> `node benchmark/run.js --verbose`

**Required fields/checklist**

- [ ] Public source cited without reproducing harmful operational details
- [ ] “Reconstructed minimal fixture” label prominent
- [ ] Expected and actual outcomes both reported
- [ ] UNDER_FLAG/MISS shown honestly; no result cherry-picking
- [ ] Benign counterpart included where possible
- [ ] No claim of complete attack-family coverage
- [ ] No unpublished target, infrastructure, or exploitable code
- [ ] Detector changes linked to a regression fixture

**Example-safe topic:** The reconstructed
`benchmark/corpus/malicious/advisory-ascii-smuggling-injection.json` expects
BLOCK for verdict-forcing instructions hidden in Unicode tag characters in a
README. Contrast it with the REVIEW treatment of unexplained tag characters in
`docs/reference.md`; do not claim prompt injection is solved
(`docs/threat-model.md`).

## 3. False Positive Friday

**Purpose and tone:** Make calibration work visible and invite counterexamples.
Treat the affected maintainer/package respectfully; the story is about an
overbroad rule and its correction.

**Reusable template**

> **False Positive Friday: [benign shape]**  
> **Where it surfaced:** [curated corpus / at-scale run / MCP cohort]  
> **Old reasoning:** [signals that produced the wrong tier]  
> **Benign reality:** [manual adjudication with evidence]  
> **Rule change:** [narrowing, including what still triggers]  
> **Regression fixture:** `[path]` — `expect: [tier]`  
> **Safety check:** [malicious counterpart that remains caught]  
> **Claim impact:** [inside/outside top-1000 scope]  
> **Open debt:** [remaining XFAIL/over-blocking, if any]

**Required fields/checklist**

- [ ] Confirmed benign behavior, not merely a complaint
- [ ] Old and new detector behavior stated
- [ ] Regression fixture committed with honest expected label
- [ ] Malicious sibling shape remains covered
- [ ] Cohort/date and denominator identified
- [ ] MCP cases explicitly excluded from the top-1000 claim
- [ ] Package name omitted until coordination permits it
- [ ] No victory language suggesting all false positives are eliminated

**Example-safe topic:** The committed
`benchmark/corpus/benign/npmrc-read-for-registry-url.json` records the only
heuristic false block surfaced in the fresh top-1000 run: `.npmrc` was read only
for `registry`, with no auth field and no network sink, so the finding became
INFO. `validation/README.md` documents the retune; the reconstructed
`advisory-eslint-scope-npmrc` token-theft shape remains HIGH.

## 4. Inside the detector

**Purpose and tone:** Explain one deterministic heuristic as a reviewable
engineering trade-off: inputs, correlations, severity, benign traps, and known
evasions. Avoid “secret sauce” mystique.

**Reusable template**

> **Inside the detector: [finding category]**  
> **Security question:** [what observable shape is tested]  
> **Inputs:** [files/metadata considered and skipped]  
> **Signal ladder:** [primitive → correlation → severity]  
> **BLOCK rule:** [high-confidence combination]  
> **REVIEW rule:** [ambiguous capability]  
> **INFO/no finding:** [benign primitive]  
> **Calibration fixtures:** [malicious + benign paths]  
> **Known blind spot:** [nonlocal/runtime/evasion limitation]  
> **Challenge prompt:** [specific counterexample readers can submit]

**Required fields/checklist**

- [ ] Deterministic inputs and file-type routing stated
- [ ] BLOCK, REVIEW, and INFO boundaries distinguished
- [ ] At least one malicious and one benign fixture
- [ ] False-positive control and possible false-negative cost discussed
- [ ] Exact severity policy linked
- [ ] No assertion of semantic understanding or complete data-flow analysis
- [ ] Safe excerpts only; no deployable payload
- [ ] Reproduction path included

**Example-safe topic:** “Computed execution, not minification.” Cite
`docs/reference.md`: computed-argument `eval`/`new Function` is REVIEW, a string
literal is INFO, and `.min.js` is skipped. Pair
`benchmark/corpus/malicious/obfuscation-eval-atob.json` with
`benchmark/corpus/benign/bundle-decoder-far-from-eval.json`; explain the
~600-character decode/execute locality calibration from `CHANGELOG.md`.

## 5. MCP manifest review

**Purpose and tone:** Teach agents and server authors to review declared
capability before connection, then state clearly what only a runtime layer can
observe. Skeptical of excess privilege, not accusatory.

**Reusable template**

> **MCP manifest review: [declared purpose]**  
> **Acquisition safety:** [package scanned first? transport?]  
> **Stated tool:** [name + description]  
> **Declared schema:** [inputs and annotations]  
> **Capability mismatch check:** [excess parameter/permission or none]  
> **Content checks:** [description/instructions Unicode, base64, injection]  
> **Connect-time decision:** [allow/review/deny and policy]  
> **Pin:** [fingerprint/recheck plan]  
> **Runtime plan:** [proxy behavior or HTTP limitation]  
> **Calibration boundary:** [why this is not covered by the top-1000 claim]

**Required fields/checklist**

- [ ] For stdio, no-execution package scan precedes server enumeration
- [ ] Explain that enumeration spawns the server with scrubbed environment,
  timeout, bounded output, and process-group cleanup
- [ ] Compare purpose to schema; do not infer intent from a name alone
- [ ] Inspect descriptions and server instructions for injection channels
- [ ] Pin includes annotations, instructions, and capabilities
- [ ] State that MCP/agent-tooling packages are currently over-blocked
- [ ] For stdio, describe `mcp-proxy` relist/hold/deny/result-scan behavior
- [ ] For HTTP, state that the proxy does not wrap it; use pin/recheck only
- [ ] Never claim manifest approval guarantees server implementation behavior

**Example-safe topic:** A synthetic `get_weather` tool whose schema also accepts
`command`, the capability-mismatch example in `docs/mcp.md`. Contrast with
`benchmark/corpus/benign/mcp-server-ships-own-manifest.json`, where a self
package-launcher manifest expects REVIEW rather than BLOCK. End with the runtime
boundary: connect-time inspection needs the later-stage stdio proxy to deny
manifest drift and scan tool results.

## 6. One security claim we intentionally do not make

**Purpose and tone:** Build trust by publishing a precise non-claim, the reason
for it, the evidence boundary, and the complementary control. Calm, direct, and
free of defensive marketing.

**Reusable template**

> **One claim we intentionally do not make: “[overclaim]”**  
> **What we can say instead:** [scoped, dated claim]  
> **Why the stronger claim fails:** [technical boundary]  
> **Repository evidence:** [doc/fixture/result path and precise fact]  
> **Failure mode:** [false positive / false negative / runtime gap]  
> **Complementary control:** [human review, sandbox, proxy, least privilege]  
> **How to challenge it:** [reproduction input or counterexample route]  
> **Wording to reuse:** [approved sentence]  
> **Wording to avoid:** [unqualified sentence]

**Required fields/checklist**

- [ ] Non-claim quoted plainly in the title
- [ ] Replacement claim includes scope, cohort, date, and metric
- [ ] Known blind spot or calibration debt cited
- [ ] Complementary control does not get promoted into another absolute claim
- [ ] Clean canary result called `not-observed`, never SAFE
- [ ] Parsed provenance not called cryptographically verified
- [ ] No implication that REVIEW is malicious or SAFE is proof
- [ ] Reader receives a reproducible way to challenge the boundary

**Example-safe topic:** “We do not claim zero false blocks on every package.”
Use the replacement sentence from this document’s editorial contract. Cite
`docs/benchmark.md`: the fresh top-1000 result is regression-gated, while the
separate 300-package MCP cohort is over-blocked. Add that MCP connect-time
approval still needs `mcp-proxy` for later stdio drift, and that static package
inspection still needs runtime sandboxing where a clean tarball can fetch its
real payload (`docs/threat-model.md`).
