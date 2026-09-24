# Detection-engine fixes and local audit — 2026-09-23

## Status

The indexed-btree detection gap is fixed in the local development engine:
hash-pinned source evidence for **2.1.2 now BLOCKS**, while paired clean **2.1.3
is SAFE**. Neither verdict needs OSV or repository comparison. This is a material
improvement, not a claim that all malicious packages or all integrations are safe.

The requested detection fixes and regression work are complete. The broader audit
found open enforcement and acquisition issues below. Close those before treating
all integration surfaces as production-ready security gates.

Everything remains local and uncommitted. The repository already contained
substantial unrelated work; it was preserved. Nothing was published, deployed or
pushed. No downloaded package source was installed or executed.

## What was missed, and what changed

The earlier released-engine comparison classified the malicious evidence as SAFE.
The development flow engine initially produced REVIEW for both malicious and clean
versions, including an internal flow-analysis failure on ordinary B-tree code.
Neither result reliably distinguished the malicious release.

The missed relationship was a runtime entrypoint starting a concealed local Node
process whose target was an obfuscated loader. Literal-import-only reachability,
minified-file exemptions and narrow inline-process detection separated the evidence.

The fix is a bounded syntax-based execution graph, not a package-name or indicator
blocklist:

- Follow statically resolved local Node subprocess targets into the runtime set,
  including custom extensions and test/build directory names. Propagate runtime,
  install and lifecycle context beyond the previous two-hop path.
- Track supported aliases and artifact-anchored path construction. Do not assume
  that inherited cwd is the package directory. Unresolved execution remains REVIEW.
- Correlate concealment flags with evidence in the **exact target file**. Unrelated
  suspicious files do not corroborate an otherwise ordinary detached worker.
- Recognize a rotated/flattened string-table loader with computed module loading.
  A minified bundle, string table or dynamic plugin load alone does not qualify.
- Include runtime minified files in repository comparison. Do not suppress specific
  concealed-execution divergences just because a build script exists. Divergence
  alone still does not prove malicious intent.
- Repair callable branch joins and function-return aggregation in flow analysis.
  Preserve function metadata, summarize repeated recursive signatures, and join
  switch cases/fallthrough conservatively. Report located unsupported semantics
  separately from actual resource exhaustion.
- Keep graph/flow coverage findings unmutable and non-promotable through guard's
  `allow-review`. Explicit hash-pinned operator approvals retain their existing role.
- Add paired inert fixtures and negative controls, plus collection, policy, diff
  and browser-parity tests. No working payload or C2 interaction was added.
- Fix validation reporting: combine `safe` and `allow`, count each review category
  once per package, and label partial corpus runs accurately.

Implementation: [execution graph](../src/execution-graph.js),
[collection plan](../src/source-plan.js), [engine](../src/auditor.js),
[flow analysis](../src/flow-analysis.js), [diff](../src/diff.js),
[policy](../src/config.js), [validation reporter](../scripts/validate-at-scale.js).

## Verification

Local environment: macOS, Node v26.0.0. Scanner build identifier:
`17c2fc605844b54d5fac4a97c3bfc7a83cefa2a10494b7663580ae23e4434a31`.
Acorn file SHA-256 (recorded separately because of finding A2):
`fc3ed7b81e58464715d0291402892f22c3d86ea75302645a330390f85d8015c9`.

| Check | Result |
|---|---|
| Full local suite through the direct runner | 810 tests; 808 passed, 0 failed, 2 skipped |
| Malicious indexed-btree 2.1.2 source | BLOCK, score 59; `hidden-local-loader` cites caller and target |
| Clean indexed-btree 2.1.3 source | SAFE, score 98; no medium/high findings |
| Calibration corpus | 72 cases; 30/31 malicious BLOCK, 1 REVIEW; no malicious SAFE or benign BLOCK |
| Frozen adversarial challenge | 180 cases/30 families; baseline retained; 33 malicious BLOCK, 57 REVIEW; 86 benign SAFE, 4 REVIEW |
| Frozen internal holdout | 20 cases/10 families; baseline retained; 10 malicious REVIEW, 10 benign SAFE |
| Browser parity | Verdict, score and findings match Node across all 272 fixtures |
| Popular-package spot check | 100 packages; 16 allow, 80 review, 4 known-vulnerability blocks, 0 errors |

The calibration corpus also has nine expected-SAFE cases receiving REVIEW and one
expected-REVIEW case receiving SAFE. REVIEW is not BLOCK. These synthetic corpora
have informed development and are not independent estimates of real-world accuracy.

The real-file regression uses fixed CDN paths, pinned SHA-256 hashes and a
reconstructed minimal manifest. The malicious manifest/archive is not part of the
available evidence. This is **not** a fresh end-to-end scan of the original registry
tarball. The source files stay in memory and are never required, evaluated or run.
The [retest script](../scripts/retest-indexed-btree.js) documents the exact hashes
and fails if either paired verdict regresses.

The 100-package check uses the first 100 entries of the existing July target list;
it is not a refreshed top-1000 validation or a statistically sampled benign corpus.
No heuristic block was observed. Four blocks carried known-vulnerability findings;
this pass did not independently adjudicate those advisories.

Review reasons, deduplicated by package (categories overlap): 58 flow-analysis gaps,
49 incomplete source scans, 45 unresolved runtime execution, 32 lonely-maintainer,
19 install-hook, 2 repository divergence, 1 code-execution and 1 persistence.
An 80% review rate is a significant operational burden even with no false blocks.

The two suite skips were the opt-in real-registry tarball test and the Windows-only
enforced-install platform test. The real macOS sandbox tests passed. Native Linux,
Windows and the full CI matrix were not run in this pass. The `npm test` wrapper
stalled in this environment; the identical direct Node test runner completed in
about 20 seconds. Do not count the wrapper attempt as a passing test run.

Reproduction commands (network is needed only for the last two):

```sh
node scripts/build-browser-extension.js
node scripts/run-tests.js --test-reporter=spec
node benchmark/run.js --json
node benchmark/adversarial/run.js --check-baseline
node benchmark/adversarial/run.js --holdout --check-baseline
node scripts/retest-indexed-btree.js
node scripts/validate-at-scale.js --list validation/calibration-2026-07-19/top1000-targets.txt --limit 100 --concurrency 4 --timeout-ms 40000 --out-dir /tmp/pkgxray-popular-check
```

Local full-test log and spot-check records are under
`/private/tmp/pkgxray-validation.pqV4dI/`. Temporary logs are supporting evidence,
not a durable published validation dataset. The original generated spot-check
Markdown had the reporting errors described above; the figures here were computed
from raw `results.jsonl` and verified through the corrected reporter.

## Broader audit: open findings

These are code-review findings, not claims of observed exploitation. No external
system was probed and no exploit reproduction was attempted.

### A1 — High: example registry proxy can serve mandatory-review results

Evidence: [artifact-gate.js](../examples/pkgxray-proxy/src/artifact-gate.js)
`bound()` and `map()`, [quarantine.js](../src/quarantine.js) approval construction,
and [config.js](../src/config.js) `guardDecision()`.

Guard deliberately refuses `allow-review` promotion for semantic coverage gaps.
However, receipt `sourceComplete` means bytes were collected, not that behavioral
analysis was complete. The example proxy accepts a matching REVIEW receipt with
completed source/vulnerability checks, then serves it under default
`reviewPolicy: warn`. A complete source scan with `flow-analysis-gap` can therefore
be delivered, including on a cache hit, despite guard's mandatory hold.

Scope: the example registry proxy under `warn`/`allow`, not an assertion that the
default safe-only guard or enforced installer permits this path.

Remedy: bind mandatory hold reasons/behavioral coverage to the approval and share
one authorization decision across consumers. A proxy must not reinterpret a
mandatory hold as an ordinary discretionary review. Until then, use proxy
`reviewPolicy: block` for enforcement.

Acceptance: real scanner receipts for each immutable coverage category must deny
delivery under every non-explicit-approval policy, on both fresh and cached paths;
ordinary policy-review behavior must remain intentional and separately tested.

### A2 — Medium: scanner build identity omits bundled parser bytes

Evidence: [artifact.js](../src/artifact.js) build-file list hashes top-level
`src/*.js`, but not `src/vendor/acorn/acorn.js`.

A parser-only update can leave `BUILD_ID` unchanged and preserve approvals created
by a different parser. The parser provenance test is useful but does not bind
runtime receipts to that parser. This is an identity/invalidation gap, not a claim
that the recorded parser hash is currently wrong.

Remedy: deterministically hash all shipped runtime analysis code and relevant data,
including vendored components. Acceptance: changing a vendored parser fixture must
change build identity and force re-evaluation of cached approvals.

### A3 — Medium: download address policy is inconsistent across paths

Evidence: [quarantine.js](../src/quarantine.js) `assertDownloadHostAllowed()` /
`downloadFile()` and [github.js](../src/github.js) `assertSafeRedirectTarget()` /
`downloadCodeload()`, compared with the DNS-aware socket lookup in
[cache-upstream-policy.js](../src/cache-upstream-policy.js).

The GitHub paths reject private-looking hostnames and IP literals but do not apply
the same check to the DNS address used by the connection. Thus the stated
public-address restriction is not fully enforced for an accepted hostname.
The initial GitHub origins are trusted and the npm path uses explicit host
allowlists, so impact is conditional; this is not an arbitrary-URL npm finding.

Remedy: share origin/redirect policy and connection-bound DNS validation, preserving
explicit private-registry opt-ins. Acceptance: use mocked DNS/transport tests for
private resolutions, redirects, cache reuse and approved private registries; do not
probe real internal services.

### A4 — Medium: secondary GitHub requests lack a total deadline

Evidence: [github.js](../src/github.js) `githubApiGet()` and `downloadCodeload()` use
socket inactivity timeouts. They do not share the total-deadline and response-abort
handling used by [http-client.js](../src/http-client.js) and the primary tarball
downloader.

A slowly progressing or interrupted upstream response can extend scan time beyond
the intended bound or leave settlement/cleanup inconsistent. Response byte limits
do not establish a total time limit.

Remedy: share bounded request handling with a deadline spanning redirects, response
error/aborted listeners, cancellation and idempotent cleanup. Acceptance: controlled
local transport tests must settle on timeout/abort and leave no partial cache file.

### A5 — Medium operational risk: review volume and validation gaps

The 100-package spot check is 80% REVIEW. Zero false blocks alone is therefore an
insufficient release-quality metric. Some coverage gaps are genuine; others arise
from conservative syntax/resolution assumptions or ordinary library constructs.
Do not suppress them wholesale just to improve the dashboard.

Remedy: triage review causes, add paired benign/unsafe fixtures before extending
semantics, track benign review rate separately, and rerun the full package corpus.
Add a genuinely new held-out family set that did not inform implementation.
Require native-platform CI and investigate the local npm-wrapper stall before
release. The current passing synthetic results cannot certify zero-day recall.

## Confirmed protections and boundaries

The audit covered source selection, bounded flow/graph analysis, scoring and policy,
repository comparison, archive/download handling, approval identity, enforced
installation, proxy/cache consumers, MCP launch/gates, browser parity and validation
reporting. Existing tests exercise archive link/path rejection, incomplete scans,
artifact integrity and identity changes, policy changes, offline script-disabled
installation, post-install byte comparison, MCP framing/results and real macOS
confinement. No additional issue was established in those tested invariants.

Important boundaries remain:

- This is bounded static analysis, not arbitrary JavaScript execution or a complete
  Node resolver. General getters/proxies, dynamic module resolution, native code,
  arbitrary side effects and some syntax/runtime surfaces remain outside the model.
- Unsupported parser syntax retains existing lexical/independent checks; a parsed
  AST or complete source inventory does not prove full behavioral coverage.
- The new subprocess graph is not a complete model of shell execution, worker
  threads, every alternative runtime or every possible path-construction idiom.
- MCP enumeration launches the selected server. Package scanning is optional and
  current connect-time logic only halts BLOCK, not all REVIEW results. Environment
  scrubbing alone is not confinement. Opt-in proxy `--sandbox` is a separate
  boundary, as documented; identical manifests do not certify implementation safety.
- Runtime downloads, transitive dependencies outside the selected scan mode,
  notifications/non-text MCP payloads and cross-call dataflow are not comprehensively
  certified by an artifact verdict.

Priority order: close A1, bind the parser under A2, unify acquisition protections
under A3/A4, then reduce review noise with evidence and fresh validation under A5.
The detection engine is substantially better; the whole-system trust contract
still needs that follow-through.
