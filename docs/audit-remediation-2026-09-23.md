# Security audit remediation — 2026-09-23

## Outcome

Implementation and local regression verification are complete for the nine
findings in [the full audit](full-audit-2026-09-23.md). No release, deployment,
commit or push was performed. Existing unrelated working-tree changes were
preserved. This is a local remediation record, not independent security
certification or a claim that arbitrary program behavior is fully modeled.

Environment: macOS, Node `v26.0.0`; repository HEAD remains
`751ff97332650f983fdc39a013dfcec855a8b4de` plus working-tree changes.
Final scanner build:
`ed2bd7e8dfb109ed9627fa71204f21cfd3397758b5d57a6b28afc26d52ded91c`.

## Findings addressed

| Finding | Implementation | Regression evidence |
|---|---|---|
| F01 — local authorization | MCP uses acquisition's parser, authorizes its canonical local path and passes a canonical `file:` reference onward. | Native temporary in-root/out-of-root forms; existing symlink boundary tests. Windows-native execution remains a CI task. |
| F02 — internal option injection | Runtime schema allowlists reject unknown arguments; only declared fields enter internal option objects. Lockfile coverage identifies enabled/completed status and evidence origin. | Internal-only arguments rejected before acquisition/provider work; enabled checks exercised through controlled provider doubles. |
| F03 — discarded flow state | Graph-aware snapshots preserve aliases/cycles; memoized joins isolate branch heaps. Conditional, short-circuit and try continuations retain state; invoked closures propagate writes while dormant inspection is isolated. Unsupported executable syntax gets a coverage gap. | All four constant-only audit probes, alias/branch-order/closure/cycle invariants, pure logical guard budget regression, existing flow tests and Node/browser parity. |
| F04 — mandatory holds served | Version-2 receipts bind mandatory hold reasons, behavioral coverage and explicit pinned override state. Guard, proxy and installer share authorization rules. Legacy receipts cannot authorize serving/installing. | Every mandatory category tested on fresh and cached proxy paths under warn/allow/block; installer rejects missing, legacy and held approvals. |
| F05 — metadata pin drift | Initialized capabilities are preserved. Metadata changes, legacy missing metadata pins and pin-store failures cause server-wide holds in enforcing modes. Explicit/previously established baselines cannot silently become unpinned. | Benign instruction/capability changes, corrupt/missing expected pin stores and existing per-tool drift tests. |
| F06 — incomplete build identity | Deterministically hash package metadata and all regular files recursively under `src/` and `bin/`, including parser and data. | Parser-only fixture change alters build identity; cache/build binding tests retained. |
| F07 — inconsistent connection policy | Shared normalized address validation is passed directly to sockets for GitHub/acquisition downloads and all MCP HTTP operations, including DELETE. Redirects revalidate; explicit private registry/cache settings remain operator-controlled. | Mocked public/private/mixed DNS answers, IPv6/origin fixtures, POST/DELETE policy wiring and controlled local integration tests. No private service probing. |
| F08 — incomplete resource bounds | Shared total HTTP deadlines, body/download caps, aborted-response handling and cleanup; bounded MCP work queues, retained bytes, outstanding/held calls, manifests/pagination and timing samples; output backpressure and ephemeral MCP staging. GitHub cache replacement is atomic. | Small bounded-stream fixtures, stalled DNS/slow-drip/output tests, partial-file cleanup, finite queue/state tests, existing framing/resource/sandbox integration tests. |
| F09 — release fail-open checks | Release checks require completed clean OSV evidence, permit only the deliberate self-source omission and reject other medium/high findings. Mandatory post-publish verification checks the validated archive digest. Credentialed publishing remains isolated. | Pure release-contract cases plus a real benign archive scanned with an offline provider double. Hosted workflow/publishing was not exercised. |

## Verification

- Full `npm test` command with dot/spec reporters: **828 tests, 826 passed,
  zero failed, two skipped**; about 20 seconds. Includes real macOS sandbox and
  localhost integration tests. The skips are the opt-in live npm tarball test
  and Windows-only install refusal test. The npm wrapper itself completed.
  Local log: `/private/tmp/pkgxray-remediation-final-tests.log`.
- Browser bundle rebuilt; Node/browser verdict, score and finding parity passes
  across the 272 calibration/challenge/former-holdout fixtures.
- Calibration: 72 cases; 30 malicious BLOCK, one malicious REVIEW, zero malicious
  SAFE and zero benign BLOCK. Verdict matrix unchanged; 61 exact matches.
- Challenge: 180 cases; 33 malicious BLOCK, 57 malicious REVIEW, 78 benign SAFE,
  12 benign REVIEW, zero malicious SAFE and zero benign BLOCK.
- Former holdout: 20 cases; ten malicious REVIEW and ten benign SAFE, unchanged.
- `scripts/retest-indexed-btree.js`: hash-pinned reconstructed 2.1.2 evidence
  remains **BLOCK, score 59**; clean 2.1.3 remains **SAFE, score 98**, with parsed
  flow analysis and no gaps. Uses a synthetic manifest; the original malicious
  archive/manifest was unavailable. No package installation or execution, OSV
  evidence or GitHub metadata is used for this comparison.
- `git diff --check`: passes.

The real-package check caught a transient regression from unnecessary snapshots
of pure logical expressions after the ordinary suite passed. That regression
was corrected, a compiled-style benign method fixture was added, and both the
real-package check and complete suite were rerun successfully.

## Deliberate behavior and compatibility changes

Eight additional benign challenge cases move from SAFE to REVIEW because their
runtime syntax has only lexical coverage: both Python families' custom-extension
entries, plus all three shell and PowerShell variants. The only newly added
category is `flow-analysis-gap`. This increases review burden; it is not an
increase in malicious blocking. Corpus bytes and labels are unchanged, and the
historical `flow-results.json` is preserved. `audit-results.json` records the
reviewed replacement baseline; regression comparison logic remains strict.

Consumers must rescan legacy version-1 approval receipts. Hash-pinned explicit
operator approvals remain visible overrides, not proof of behavioral safety.
MCP guard no longer leaves staging directories behind; returned temporary paths
are null and approved promotion happens before cleanup. Unknown MCP options are
now errors, including undocumented internal injection hooks.

## Remaining release checks and limitations

Run the native Linux/Windows and supported Node-version CI matrix, then the
hosted release workflow in dry-run mode. Post-publish digest/advisory verification
cannot be exercised before a release exists. These checks do not cryptographically
verify npm provenance or establish npm/GitHub source parity.

No new live top-1000 run, deployed-service audit, external adversarial evaluation
or third-party parser-internals audit was performed. Static interpretation is
bounded and approximate; REVIEW is not BLOCK, and SAFE is not proof of
harmlessness. The synthetic challenge sets are development-informed regression
data, not independent real-world accuracy measurements.
