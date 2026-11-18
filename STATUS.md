# 1.3 release readiness

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

## Remaining release gates

- Resolve the large-package worker reliability limitation, rerun the same frozen cases on the final candidate, and integrate reviewed changes into main through the existing protected release process.
- Obtain independent tester feedback on setup, actionable findings and review friction. Convenience package controls do not establish real-world accuracy or user acceptance.
- VM execution remains experimental and opt-in. Linux/Windows real-guest validation is outstanding; static/unit checks do not establish guest confinement.
- Publish npm, registry metadata, website instructions and hosted service deliberately. No release, deployment, registry update or email outreach has occurred in this implementation pass.
