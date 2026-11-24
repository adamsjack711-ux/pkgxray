# 1.3 release readiness

## Executable-distribution scanner branch — 2026-11-24

- Canonical checkout: `/Users/jackadams-lovell/pkgxray/executable-distribution-scanners` on `feature/executable-distribution-scanners`, prepared for review against `origin/main` at `61ea28366cd450d82de584d0d6f9c83bd3588054`.
- Implemented the Experimental `scan-distribution` pipeline for extracted directories; exact-version Open VSX and VS Code Marketplace coordinates; and local or digest-bound HTTPS ZIP/VSIX/XPI/CRX/raw-TAR/gzip-TAR archives. It provides bounded transactional extraction; registry redirect/transport handling and manifest-coordinate binding; descriptor scanners for GitHub/GitLab/Jenkins CI, VSIX/browser/JetBrains extensions, infrastructure/OCI/Linux/desktop formats, and agent packages; existing-source-auditor routing, including extensionless Node-style VSIX entrypoints; opt-in recursive guarding for exact npm/PyPI and commit-pinned GitHub references; exact-digest local or anonymous-registry OCI manifest/config/raw-or-gzip-layer verification and lifecycle-descriptor dispatch; immutable archive recursion; artifact-bound receipts; CRX2/CRX3 verification; and operator-pinned Sigstore SLSA verification bound to exact artifact bytes, subject, certificate identity, and issuer.
- The pipeline never installs or executes targets. Remaining boundaries are authenticated or multi-platform OCI and unsupported layer/whiteout formats; Firefox, Chrome, JetBrains, Terraform/Helm, and Jenkins store/registry clients; bzip2/xz/zstd, sparse/link-bearing TAR, and binary package extraction; format-native VSIX/XPI/JAR/Linux/platform signatures; and source/bytecode analysis of JetBrains JARs and Jenkins plugin binaries. Bounded PAX path/size and GNU long-name records are supported without applying ownership, mode, xattr, or timestamp metadata. Open VSX / Marketplace acquisition without `--sha256` is deliberately recorded as transport-only and partial, while exact manifest identity/version mismatches block. These gaps stay explicit and prevent unsupported work from being represented as verified.
- Verification on macOS arm64 / Node 26.0.0: 94 focused distribution scanner, archive, OCI, provenance, receipt, recursive, source-audit, ecosystem, pipeline, registry, and CLI tests passed. The final full repository suite passed 1,260 tests (1,255 passed, five skipped, zero failed) in 28.5 seconds with local fixture-server sockets enabled. Lint, documentation smoke checks, diff checks, and the npm package dry-run passed. Live read-only journeys scanned Open VSX `redhat.java@1.30.0` (49,091,909 decoded artifact bytes, SHA-256 `f17399053b80bdea62b3d69094dd8c499732eab8f88480e5f577b5d31e526004`) and VS Code Marketplace `ms-python.python@2026.4.0` for `linux-x64` (17,823,311 decoded artifact bytes, SHA-256 `1d07e60d5eab257ea5d691b26def3fff642b4d2c04fab94424e8b8fe25baf656`); both matched requested coordinates and correctly returned REVIEW for unverified provenance / transport-only acquisition. The maintained Sigstore 5 verifier accepted a genuine historical signed bundle and rejected mutated signature and signer policy in the network-enabled integration test; the same test failed closed as unverified when TUF metadata could not refresh inside the restricted sandbox. No downloaded VSIX was retained. No deployment or publication occurred.

## Merged candidate

[Release PR #111](https://github.com/adamsjack711-ux/pkgxray/pull/111) merged to
`main` at `b18eca2894b62d89a1de9552d1217772892228f5` on 2026-11-18. Runtime
commit `fa646a9` reduces the cost of copying closures and
scalar values during flow analysis. The [worker measurements](benchmark/1.3-worker-reliability-2026-11-18.json)
record three individual and three concurrent runs per frozen package on macOS
arm64 with Node 26.8.2. All 12 reports matched the earlier candidate byte for
byte. Lodash finished in 22.1–23.3 seconds and Zod in 23.3–24.2 seconds under
the 30-second worker deadline. Slower hosts can still reach that deadline.

The [11-package MCP trial](benchmark/1.3-package-results-worker-followup-2026-11-18.json)
returned three allow and eight review decisions. The six mandatory coverage
holds, artifact hashes, finding counts by category and severity, and review
plans all matched the preceding trial. The [release dry run](https://github.com/adamsjack711-ux/pkgxray/actions/runs/44232030290)
validated the packed build and verified its transfer digest.

An independent agent tested the local archive with SHA-256
`b0bfe8d307a381fabcbe8911db1431b96acb5e94147b7ff7a3cb844a51117ab3`.
The CLI allowed `ms@2.1.3` and returned an eligible review for
`picocolors@1.1.1`. Its feedback about locating cited findings in JSON led to
a [tested report-reading example](docs/testing-1.3.md). Human usability
feedback and publication remain open. VM execution remains experimental, with
Linux and Windows guest validation outstanding.

## Follow-up on 2026-11-24

- GitHub confirmed the merge and passing PR checks. The successful release dry run used runtime commit `fa646a9`. npm `latest` was `1.2.1`, and GitHub had no `v1.3.0` tag.
- The follow-up docs checkout is `/Users/jackadams-lovell/pkgxray/release-1.3-main`, branch `docs/1.3-review-walkthrough`, based on `b18eca2`. Its local `npm pack --ignore-scripts` archive matched the recorded candidate digest `b0bfe8d307a381fabcbe8911db1431b96acb5e94147b7ff7a3cb844a51117ab3`. The packaged CLI, Compose, and both MCP launchers passed smoke checks.
- An independent CLI trial of the earlier `f7de2a5` archive identified the need for an exact-archive review walkthrough. Its handoff and sanitized verification are in `~/outputs/pkgxray-1.3.0-independent-test.txt` and `~/outputs/pkgxray-1.3.0-review-walkthrough-verification.txt`. The tester independently ran the integrated [walkthrough](docs/testing-1.3.md#practice-reviewing-an-exact-archive) against the merged archive. Both runs exited 3. With OSV reachable, the review was eligible and pending. With restricted networking, the missing advisory check made the review ineligible. The fixture was left inert and no choice was submitted.
- Lint passed. The full suite on the merged runtime passed 1,161 tests, with five skipped and zero failed, on macOS arm64 and Node 26.0.0 with fixture-server sockets enabled.
- The exact-merge [CI matrix](https://github.com/adamsjack711-ux/pkgxray/actions/runs/44232938974) and [release dry run](https://github.com/adamsjack711-ux/pkgxray/actions/runs/44232962846) passed. The validator independently downloaded the dry-run archive, which matched its npm 10 local pack byte for byte at SHA-256 `7231ea05e41dc02abc6c110ee9230cf253fa222782ff8eda549504bda24c8c7d`. The full evidence and commands are in `~/pkgxray/validation-1.3.0/`.
- One fresh Node 22 cohort returned a Lodash timeout while other performance work was active. The cause remains undetermined. A same-commit repeat completed all 11 scans with three allow, eight review, and clean OSV checks. Serial and paired direct worker checks returned both large-package reports in 24.18–24.79 seconds, with matching report hashes.
- Three additional same-session MCP trials sent the pinned Lodash and Zod requests together under Node 22.20.0 on macOS arm64. All six scans completed with the same archive identities, findings, checks, and mandatory holds as the full-cohort repeat. End-to-end time, including acquisition, ranged from 24.4 to 31.9 seconds. Reports and the adapted harness are in `~/pkgxray/validation-1.3.0/paired-mcp-b18eca2.IyR69H/`. The earlier timeout remains part of the evidence.
- Independent correctness review of `fa646a9` found no release-blocking issue. The allocator experiment `61b61a6` stays in the performance worktree. Keep `b18eca2` as the release runtime given the passing repeat and paired MCP results.

## Full-scan reconciliation on 2026-11-24

- Updated the Swamp `npm-drift` extension's `npm:zod@4` lock resolution from 4.4.3 to 4.6.7 for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The patched registry integrity matches the lock and the version returned zero OSV advisories. Deno type-checked the model from a fresh cache with the frozen lock. The model schema accepted valid input and rejected invalid input. Swamp's extension doctor, model registration, and repo lint checks passed.
- The exact CI npm archive contained 80 files, all byte-identical to `b18eca2`. The archive scan with source analysis enabled returned BLOCK with six high findings. Five referred to detector signatures in `src/auditor.js`. The sixth classified the X.509 common-name OID in `src/sandbox.js` as an IP address. The raw verdict and all findings remain in the report. The separate release gate passed its digest and OSV checks with its configured source omission.
- The archive scanner reported partial behavior coverage because it did not resolve a computed Compose worker launch. The source resolves that executable to the bundled `pkgxray-worker.mjs` relative to `integration.mjs` and passes the scanner root separately as an argument. The coverage hold remains in force. The source checkout scan inspected 544 files and also reported partial coverage. The public MCP npm lockfile check completed with zero OSV advisories across 91 pinned packages.
- The Deno lockfile is outside the npm archive. An npm 10 repack after the update matched the CI artifact byte for byte at SHA-256 `7231ea05e41dc02abc6c110ee9230cf253fa222782ff8eda549504bda24c8c7d`. Scan outputs and parity evidence are in `~/outputs/pkgxray-1.3.0-full-scan.IzCc1G/`.

## Earlier candidate at f7de2a5

Observed 2026-11-17. Local implementation and release validation; no publication or deployment.

## Canonical candidate

- Checkout: `/Users/jackadams-lovell/pkgxray/release-1.3`, branch `polish/1.3-release`.
- Base commit: `50865008115f799629f3df580965b825a7218cf2`, preserved from closed PR #108.
- Integration target: `main`, observed at `e736f0fa5910c2dbea64ddb928ba9a79789b6531` during this session; base candidate was 12 commits ahead, zero behind. No new remote CI run or merge has been performed.
- The commit containing this handoff captures the reviewed changes on `polish/1.3-release`; Jack requested committing and pushing this branch. The older `architecture/1.3-auto-resolution` checkout and separate 2.0 prototypes were preserved.
- npm latest was verified as 1.2.1 during this session. The seven requested PRs (#103–106 and #108–110) were closed without merging; branches were preserved.

## Implemented

- Restored ordinary `allow-review` compatibility across guard, installer, MCP and proxy receipt consumers, while retaining mandatory vulnerability, provenance and coverage holds. Explicit Proceed/Decline remains additive. Stale review IDs are rejected, and CLI install-review evidence now matches the installer.
- Added candidate archive/local MCP testing instructions; corrected review guidance, Compose packaging, experimental VM limits, unreleased changelog and project status.
- Synchronized hosted scanner version reporting with its actual build, separately from the last published CLI install suggestion. Added release metadata/tag checks and actual packed CLI/Compose/MCP smoke checks to release validation.
- Fixed source-target collection using parsed syntax instead of diagnostic-string matches; developer-only scripts no longer create false runtime escape gaps. Computed module loading and reachable lifecycle scripts remain mandatory coverage concerns.
- Narrowed the IP destination heuristic for literal built-in BlockList policy data. Arbitrary aliases, reflection, mutations and uncertain dispatch retain the original finding. This is a file-local heuristic adjustment, not a proof of package safety.
- Optimized readonly flow-analysis snapshots. Independent agent review caught alias-loss regressions in intermediate changes; corrected code isolates any declaration-bearing branch and other control-flow joins, while allowing private locals in fresh readonly invocations. Added regression cases for exported aliases, closures and default parameter effects.

## Final local verification

Final scanner build: `01dbc36c2b9d5197cbc995ddccb1e57225cf9bb86cca52225e4d6b9f1cafdea2`.
Archive: `.pack/pkgxray-1.3.0.tgz`, 78 files, 458,359 compressed bytes.
SHA-256: `b34e2b6bdbe96bfe4dd60887ff55625feb7d0529622b419d502c674e3dd5fc97`.
Environment: macOS arm64, Node 26.0.0. Validation ran before the changes were committed above the base commit; the build hash identifies the tested runtime. The retained validation reports describe that pre-commit measurement state.

Three agents separately handled compatibility/performance, documentation/source planning, and the frozen package trial. They cross-reviewed the flow-analysis, BlockList and lifecycle-reachability changes; this is agent review, not external tester acceptance.

- Full final suite: 1,166 total, 1,161 passed, five skipped, zero failed (24.9 seconds). Includes core, proxy, Compose and documentation checks. Local fixture servers were enabled.
- Lint, generated browser parity and website validation passed. Calibration (84 authored cases), adversarial/holdout baseline gates and ten upgrade comparisons passed. These are synthetic checks, not measured real-world accuracy.
- Public Worker: 23 unit tests and 12 local HTTP checks passed; type generation and non-deploying build passed. Scanner identifies as 1.3.0, while the install suggestion remains the verified published 1.2.1.
- Exact packed archive: CLI version, inert Compose scan, both MCP launchers, tool discovery and inert SAFE/BLOCK evidence passed. Inventory contained no unexpected fixture/test/.env paths.
- Release self-guard passed with completed clean OSV and intentionally disabled source scanning, as required by the existing verifier. The static scanner's own signature definitions are tested separately; this does not prove provenance or source parity.
- Real stdio MCP smoke passed eight checks, including cache/concurrent sharing, mandatory review holds, rejected promotion/out-of-root input, inert Compose, and a live npm/OSV scan of `ms@2.1.3` (allow, source/vulnerability checks complete; dependencies not requested, provenance absent).
- Final frozen 11-package trial: 11 reports, three allow, eight review, zero block, zero errors. All archive/policy identities matched, all 11 OSV checks completed clean, and no overrides or target execution occurred. The three MCP formatter gaps and the Everything denylist false HIGH are gone. React still has flow gaps; large packages retain file-cap/analysis holds. See `benchmark/1.3-package-results-followup2-2026-11-17.json`. Baseline and intermediate reports are preserved; this convenience cohort is not an accuracy estimate.

Durable evidence: `benchmark/1.3-release-validation-2026-11-17.json`, `benchmark/1.3-performance-2026-11-17.json`, and the package-trial reports linked from `docs/1.3-package-trial.md`. Raw final logs are in `/private/tmp/pkgxray-1.3-verified/` and are temporary. Earlier audit/intermediate archives and their passing checks are superseded.

## Known reliability limitation

The controlled comparison changed only flow-analysis.js on identical frozen source snapshots. Direct analysis improved from 30.309 to 21.435 seconds for Lodash and from 49.551 to 27.261 seconds for Zod. With the unchanged production worker limits, Lodash completed in 28.893 seconds but Zod still timed out at 30 seconds. A later full MCP cohort returned both reports, which does not resolve the inconsistency or prove adequate headroom on other machines/concurrent load.

Full direct reports differ only in flow-gap citations (one Lodash, 17 Zod); non-flow findings are identical and mandatory coverage holds remain. No deadline, source-file cap, or policy gate was relaxed. The remaining measured cost is repeated copying/joining of large captured abstract-state graphs. The next bounded engineering step is to reduce that cost with regression-preserving analysis changes and repeated production-worker checks before claiming reliable large-package support.

## Release gates recorded at f7de2a5

- Resolve the large-package worker reliability limitation, rerun the same frozen cases on the final candidate, and integrate reviewed changes into main through the existing protected release process.
- Obtain independent tester feedback on setup, actionable findings and review friction. Convenience package controls do not establish real-world accuracy or user acceptance.
- VM execution remains experimental and opt-in. Linux/Windows real-guest validation is outstanding; static/unit checks do not establish guest confinement.
- Publish npm, registry metadata, website instructions and hosted service deliberately. No release, deployment, registry update or email outreach has occurred in this implementation pass.
