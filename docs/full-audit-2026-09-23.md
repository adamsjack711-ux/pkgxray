# pkgxray full local security audit — 2026-09-23

Follow-up: implementation and local retest results are recorded in
[audit-remediation-2026-09-23.md](audit-remediation-2026-09-23.md).
The findings and statuses below preserve the original pre-fix audit snapshot.

## Executive assessment

**Hold a security-focused release pending the high-priority fixes.** The engine
has improved substantially, but passing the current suite does not establish the
security contract across its transports and enforcement adapters.

This second, broader pass identifies **nine actionable findings: four High and
five Medium**. Five findings are additional to the earlier detection audit; the
earlier approval, proxy and acquisition findings remain open. No Critical issue
was established. Severities are qualitative engineering priorities, not CVSS scores.

This was an audit, not an implementation pass. No product code, policy, test
expectations or release configuration was changed. Only this report was added.
No malicious package was installed or executed, no internal service was probed,
and no exploit or detection-evasion payload was constructed.

## Snapshot, method and scope

- Repository HEAD: `751ff97332650f983fdc39a013dfcec855a8b4de`, plus the existing
  dirty working tree. This report audits the working tree, not just that commit.
- Scanner build: `17c2fc605844b54d5fac4a97c3bfc7a83cefa2a10494b7663580ae23e4434a31`.
- Environment: macOS, Node `v26.0.0`.
- Method: trust-boundary code review, cross-surface call tracing, existing unit and
  integration tests, calibration/baseline checks, and harmless constant-value
  probes of the abstract interpreter. The probes parsed text; they did not
  execute it.
- Reviewed areas: source acquisition and archive handling; source planning;
  execution/flow analysis and verdict folding; policy and receipts; npm lockfile
  auditing and enforced installation; CLI/MCP entrypoints; MCP client, live gate
  and pin store; HTTP cache and example npm proxy; browser input/rendering and
  parity; release/test configuration; validation methodology.
- Not certified: every heuristic's semantic completeness, the vendored parser's
  internals, deployed services/accounts, the marketing site's infrastructure,
  external automation models, all supported operating systems/Node versions, or
  the security of third-party runtimes. No new live advisory-database or
  full-top-1000 run was performed during this pass.

Evidence strength is stated per finding. Code-confirmed means the relevant branch
and its callers were traced; it does not mean an exploit was reproduced.

## Findings at a glance

| ID | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| F01 | High | MCP local-reference authorization and resolution disagree | Code-confirmed; native Windows not exercised | New |
| F02 | High | MCP tool arguments reach trusted internal options | Code-confirmed | New |
| F03 | High | Flow state can be discarded while analysis reports complete | Harmless probes + code review | New |
| F04 | High | Example registry proxy serves mandatory-review receipts | Code-confirmed | Earlier A1, still open |
| F05 | Medium | Live MCP gate does not enforce manifest-level pin drift | Code-confirmed | New |
| F06 | Medium | Approval build fingerprint excludes vendored parser | Code-confirmed | Earlier A2, still open |
| F07 | Medium | Outbound address validation differs by transport/operation | Code-confirmed; no network reproduction | Earlier A3, expanded |
| F08 | Medium | Resource limits are not end-to-end | Code-confirmed | Earlier A4, expanded |
| F09 | Medium | Release checks accept incomplete verification | Code-confirmed; CI not executed | New |

## F01 — High: MCP local-reference authorization and resolution disagree

**Locations:** [bin/mcp-server.js](../bin/mcp-server.js), lines 355–362 and
457–463; [src/quarantine.js](../src/quarantine.js), lines 650–697 and 582–613.

The MCP entrypoint decides whether root authorization is needed using its own
string-prefix classifier. The downstream resolver accepts a broader set of local
references, including native absolute paths and additional relative-prefix forms.
On Windows, the transport classifier does not account for the native absolute
path forms that the resolver explicitly supports. There are also prefix
differences independent of Windows.

Consequently, some references classified as non-local at the authorization layer
are treated as filesystem inputs downstream. The guard copies and reads local
source, and its structured response includes collected source content. The
operator-approved-root check therefore does not cover every filesystem path the
tool can resolve.

**Impact/conditions:** an MCP caller can cross the intended local-read boundary
when it supplies a reference in the mismatched classification set. The process's
own filesystem permissions still apply. This is not a claim of OS privilege
escalation. No unauthorized file was read to validate this finding.

**Remediation:** resolve/classify once with a shared reference parser, authorize
every resolved local reference against canonical operator roots, then pass only
that authorized representation to acquisition. Do not maintain a second,
narrower transport-specific classifier.

**Acceptance:** platform-native reference classification parity tests on POSIX
and Windows; temporary in-root/out-of-root directory fixtures; consistent refusal
before any copy/read; existing symlink-boundary checks retained.

## F02 — High: MCP tool arguments reach trusted internal options

**Locations:** [bin/mcp-server.js](../bin/mcp-server.js), lines 442–520,
640 and 674–681; [src/lockfile.js](../src/lockfile.js), lines 589–597 and
723–729.

The advertised schemas say `additionalProperties: false`, but runtime validation
checks only selected fields and never rejects unknown keys. Lockfile tool calls
then spread caller arguments into the internal audit options.

That internal API includes trusted/test-only inputs such as precomputed OSV
results. Those inputs can substitute for a live vulnerability query while the
returned coverage field still describes vulnerability checking as enabled. The
deep-audit path also accepts a staging-directory option without the root checks
applied to that option by the separate guard tool.

**Impact/conditions:** the transport does not preserve the distinction between
caller-supplied data and scanner-established evidence, or consistently enforce
filesystem-option authority. This is separate from the intentionally exposed
option to disable a check: an explicit disabled check must be reported as such,
not represented as completed authoritative work.

**Remediation:** construct fresh per-tool option objects from an explicit
allowlist; reject unknown fields; keep injection seams inaccessible from JSON-RPC;
validate all filesystem-bearing options through one shared authorization helper.
Track enabled, completed and evidence-origin states separately.

**Acceptance:** transport tests rejecting internal-only fields, verification that
the vulnerability provider is actually invoked for an enabled check, and tests
showing no filesystem-bearing option bypasses the root policy. No hostile scan
result or remote exploit fixture is necessary.

## F03 — High: flow state can be discarded without a coverage gap

**Locations:** [src/flow-analysis.js](../src/flow-analysis.js), lines 73,
307, 318–324, 348–350 and 427; [src/sensitive-flows.js](../src/sensitive-flows.js),
lines 156–164.

The interpreter's state model is not consistently conservative:

- Updating an object through an alias replaces one binding rather than updating
  the abstract object seen by all aliases.
- Conditional-expression branches are evaluated in cloned scopes, but their
  effects are not joined back into the surrounding scope.
- Try/catch bodies likewise use cloned scopes without merging their state into
  the continuation.
- Scope cloning is shallow. Nested mutable property maps can remain shared
  between branches, allowing one branch's state to overwrite the other's.

Four harmless, constant-only probes confirmed the mismatch:

| Probe | Required abstract result | Observed result |
|---|---|---|
| Change a property through an alias | Updated constant `2` | Stale constant `1` |
| Update a variable inside a nonthrowing try block | Updated constant `2` | Stale constant `1` |
| Assign `2` or `3` in conditional branches | Join of possible branch values | Pre-branch constant `1` |
| Assign a nested property in two branches | Join of both possibilities | Only the later branch's constant `2` |

All four returned `status: parsed` with **no gaps**. Since the sensitive-flow
adapter trusts that status, it does not invoke its lexical fallback or emit a
coverage warning for these cases.

**Impact/conditions:** modeled flows can lose value/capability information and
produce false negatives. This pass confirmed incorrect abstract state, not a
specific successful malware bypass; independent detectors may still flag a
particular package.

**Remediation:** define explicit abstract heap/alias semantics, immutable or
copy-on-write branch state, and common joins for conditional, try/catch/finally,
loop and function effects. Until a construct's effects are modeled, report
incomplete analysis instead of silently treating it as complete.

**Acceptance:** retain these constant-only semantic tests, add benign branch-order
and alias invariants, and test monotonic information preservation. Add safe
synthetic source/sink markers only after the state model is correct. Require
Node/browser parity and existing corpus baselines throughout.

**Related coverage boundary:** unsupported parser syntax is deliberately excluded
from the adapter's gap-status list. A harmless TypeScript declaration returned
`unsupported` with no hints. Existing lexical checks remain, but reports should
distinguish lexical-only from parser/flow coverage; complete byte collection is
not complete behavior analysis.

## F04 — High: the example registry proxy serves mandatory-review receipts

**Locations:** [artifact-gate.js](../examples/pkgxray-proxy/src/artifact-gate.js),
lines 55–64 and 85–87; [src/quarantine.js](../src/quarantine.js), lines 315–350;
[src/config.js](../src/config.js), lines 496–504.

Guard refuses ordinary `allow-review` promotion for mandatory semantic coverage
gaps. The receipt, however, records source-byte completeness rather than
behavioral completeness. The example registry proxy accepts a matching REVIEW
receipt with completed source/vulnerability checks, then serves it under the
default `reviewPolicy: warn`. Its cached path applies the same rule.

**Impact/conditions:** a source-complete artifact with an incomplete behavioral
assessment can be served despite the guard's mandatory hold. This finding applies
to the example registry proxy under `warn`/`allow`, not to the safe-only guard or
enforced install's existing ALLOW-receipt requirement.

**Remediation:** put mandatory hold reasons and behavioral scope in the bound
receipt; make every consumer use the same authorization contract. As an interim
deployment measure, set the registry proxy's review policy to `block`.

**Acceptance:** source-complete receipts with each mandatory gap must deny serving
on fresh and cached paths under non-explicit-approval policies. Ordinary
discretionary reviews must be distinguishable and intentionally tested.

## F05 — Medium: live MCP gate ignores manifest-level pin drift

**Locations:** [src/mcp-pin.js](../src/mcp-pin.js), lines 145–175;
[src/mcp-proxy.js](../src/mcp-proxy.js), lines 240–251, 285–296 and 350–381.

The pinning layer correctly reports `metaChanged` when approved server
instructions/capabilities change. The live proxy, however, marks only added or
changed **tool names** as drifted. A metadata-only change supplies no such names,
so it does not cause a pin-based denial. The proxy also constructs its manifest
with an empty capabilities object rather than retaining initialized capabilities.

**Impact/conditions:** pinning does not enforce all of the approval fields it
claims to cover. A changed instruction that independently matches a malicious
text rule can still be blocked; a heuristic verdict is not a substitute for
honoring the pinned metadata approval.

**Remediation:** preserve initialization capabilities and make metadata drift a
server-level hold until explicit reapproval. Separately distinguish an
intentionally unpinned session from a pinned session whose store is unavailable;
the current catch-and-continue behavior is not a fail-closed pin guarantee.

**Acceptance:** benign instruction-only and capability-only changes must require
reapproval in enforcing modes even with unchanged tools and clean heuristic
results. Test unreadable/corrupt expected pin stores without launching a server.

## F06 — Medium: build identity excludes the vendored parser

**Location:** [src/artifact.js](../src/artifact.js), lines 40–46.

The approval fingerprint hashes top-level source files but omits
`src/vendor/acorn/acorn.js`. A parser-only update can therefore retain the same
build ID and reuse approvals from a different analysis implementation. The parser
provenance test does not repair this receipt-binding gap.

**Remediation/acceptance:** deterministically include all shipped runtime code and
relevant data in build identity. A parser-fixture change must change that identity
and invalidate cached approvals. Keep provenance/license checks too.

## F07 — Medium: outbound address policy is not consistently enforced

**Locations:** [src/quarantine.js](../src/quarantine.js), lines 1308–1330 and
1380–1394; [src/github.js](../src/github.js), lines 77–84 and 281–367;
[src/mcp-client.js](../src/mcp-client.js), lines 630–654 and 785–806.

The cache upstream policy validates the actual DNS address used by the socket.
The GitHub download paths primarily inspect hostname text/IP literals instead.
An accepted hostname is not proof that the connection destination is public.

The MCP HTTP client applies validated, pinned addresses to its POST requests,
but its session-cleanup DELETE uses a separate raw request path without the same
address validation/pinning. Address normalization and denied ranges also differ
between helpers.

**Impact/conditions:** promised connection restrictions are incomplete. The
GitHub starting origins are trusted, npm has explicit origin allowlists, and TLS
validation still applies. Actual reachability depends on deployment and peer
behavior; no private-address request was attempted in this audit.

**Remediation/acceptance:** share connection-bound DNS and origin policy for every
operation, including redirects and cleanup, while preserving deliberate private
registry opt-ins. Use mocked resolver/transport tests and normalized address
fixtures, not probes against real internal services.

## F08 — Medium: resource limits are not end-to-end

**Locations:** [src/cache-client.js](../src/cache-client.js), lines 84–130 and
136–171; [src/github.js](../src/github.js), lines 150–205, 281–367 and 540–554;
[src/attestation.js](../src/attestation.js), lines 91–140;
[src/mcp-client.js](../src/mcp-client.js), lines 657–704 and 749–810;
[src/mcp-proxy.js](../src/mcp-proxy.js), lines 114–136 and 775–795.

- Cache-client JSON accumulates without a response-body cap. Its tarball stream
  also lacks a local compressed-byte cap; extraction checks occur only later.
- Several HTTP paths use inactivity timeouts rather than a total deadline and
  do not consistently settle on response abort/error. The MCP HTTP enumeration
  has no single wall-clock deadline spanning DNS, initialization, pagination and
  session cleanup.
- Live MCP framing bounds individual messages, but queued work, in-flight maps,
  held calls and recorded timing samples have no comparable aggregate budget or
  stream backpressure. The MCP audit server also dispatches asynchronous requests
  without a concurrency ceiling and retains guard staging trees.

**Impact/conditions:** a malfunctioning or hostile peer can consume memory, disk
or scan/session time beyond the advertised per-request/per-frame bounds. This
was established through resource accounting in code, not a stress attack.

**Remediation:** use shared bounded HTTP primitives, cancel the whole operation
on deadline, cap bytes before writing, bound concurrent/queued work, honor stream
backpressure and define staging retention. Keep private-cache trust explicit.

**Acceptance:** deterministic fake-clock and small fake-transport tests for
deadlines, aborts and caps; bounded queue saturation tests; cleanup and
backpressure assertions. Avoid high-volume stress payloads.

## F09 — Medium: release checks accept incomplete verification

**Locations:** [.github/workflows/release.yml](../.github/workflows/release.yml),
lines 57–68 and 120–124; [src/quarantine.js](../src/quarantine.js), lines 165–203
and 315–334.

The self-guard intentionally disables source analysis, then accepts every REVIEW
exit as a warning. This cannot distinguish the intentionally omitted source
check from a failed vulnerability check. Publishing can proceed without the
vulnerability verification the step claims to establish.

Post-publish verification is `continue-on-error` and invokes guard with source
scanning disabled. It neither compares the registry archive's digest to the
validated archive nor establishes the source parity described in the workflow
comment. Parsed provenance metadata is not cryptographic signature verification.

**Remediation:** gate on explicit structured outcomes for required checks and
permit only the intended source-scan omission. Compare published artifact bytes
with the checked digest. Report provenance presence separately from authenticity,
and make failed verification an explicit failed release status requiring action.

**Acceptance:** dry-run validation with a mocked unavailable vulnerability service
must stop publication eligibility; clean required checks must pass; a simulated
published-digest mismatch must fail verification. No real publication is needed.

## Verification results and their limits

Freshly rerun in this pass:

| Check | Result |
|---|---|
| Full direct test runner | 810 total; **808 passed, 0 failed, 2 skipped**, about 20 seconds |
| Calibration | 72 cases; 30/31 malicious BLOCK, one REVIEW; no malicious SAFE or benign BLOCK |
| Adversarial baseline | 180 cases/30 families; baseline retained; zero SAFE misses/false blocks |
| Internal holdout baseline | 20 cases/10 families; baseline retained; ten malicious REVIEW, ten benign SAFE |
| Browser parity, within full suite | Verdict/score/findings agree across 272 fixtures |
| Harmless state probes | Four incorrect state summaries, each reported parsed without gaps |
| Unsupported-syntax coverage probe | Parser unsupported; no gap hint emitted |

The two suite skips were the opt-in live-registry test and Windows-only enforced
install platform test. Real macOS confinement tests passed. Native Windows/Linux
and the CI matrix were not run here. The prior `npm test` wrapper timeout remains
unresolved; the successful run here used `node scripts/run-tests.js` directly.

Fresh test log: `/private/tmp/pkgxray-full-audit.D8EvqN/tests.log`.
Temporary logs are not durable published validation artifacts.

The [earlier detection audit](detection-audit-2026-09-23.md) records the
hash-pinned indexed-btree source-only regression (malicious BLOCK, paired clean
SAFE), and the 100-package check (16 allow, 80 review, four known-vulnerability
blocks, no heuristic blocks). Those network measurements were **not rerun** in
this pass. The scanner build is unchanged. The malicious original tarball was
not available; that regression used reconstructed source evidence.

The existing synthetic corpora informed implementation; they are not independent
zero-day recall estimates. The calibration corpus still has nine expected-SAFE
cases at REVIEW. The 80% review rate in the earlier real-package spot check
remains a material usability problem. REVIEW must not be counted as BLOCK.

## Positive controls and known boundaries

The examined controls and passing tests provide useful evidence for:

- Static default acquisition: no package install hooks or package code run.
- Strongest-supported integrity selection, artifact identity checks, bounded
  archive inspection, and rejection of archive links/special entries.
- Explicit source-inventory gaps and mandatory guard holds; non-offsetting known
  vulnerability verdicts; hash-pinned operator overrides.
- Enforced npm installation from approved archives, offline/script-disabled npm,
  comparison of installed file bytes, policy/input rechecks and rollback backup.
- MCP frame/result size checks, tool gating and result inspection, plus opt-in
  process confinement that refuses unavailable backends.
- Browser escaping of evidence-controlled strings and Node/browser engine parity.
- Release separation between validation and the credentialed publish job, with
  a checked archive digest and lifecycle scripts disabled during publish.

These are tested invariants, not proof that surrounding code is defect-free.
Receipts are trusted local records, not signed attestations. Canary mode explicitly
executes code and is not equivalent to the more restrictive MCP sandbox: its
isolation tiers and filesystem/network allowances must be evaluated separately.
This audit did not detonate malware or assert that canary can clear a package.
MCP enumeration itself launches a selected stdio server; environment scrubbing
is not confinement. Static analysis does not model arbitrary runtimes, native
code, every dynamic import, or cross-call behavior.

## Remediation order and release criteria

1. **Close transport authority gaps:** F01/F02. Share parsing/authorization and
   construct strict per-tool option objects. Run native-platform contract tests.
2. **Restore analysis/enforcement correctness:** F03/F04. Preserve abstract state
   or report gaps; make mandatory holds authoritative across every consumer.
3. **Repair approval guarantees:** F05/F06. Enforce metadata pins and bind the
   exact parser/runtime implementation to every approval.
4. **Unify acquisition and resource contracts:** F07/F08. One network policy and
   bounded operation lifecycle, including secondary and cleanup requests.
5. **Make release evidence mandatory:** F09. Required completed checks and exact
   published-byte verification, followed by platform CI and a new validation run.

After the high findings are fixed, retain all existing baselines, add the missing
semantic/transport contract tests, run genuinely new held-out cases, and triage
benign REVIEW reasons before weakening policy. The next improvement should be
correct state and authority handling—not simply more detection signatures.
