# At-scale validation — top-1000 npm packages

The [calibration benchmark](../benchmark/) measures a curated corpus of
labelled fixtures. This harness scans registry packages to measure heuristic
block candidates, scan completion, and manual review burden. The historical
results below apply to their recorded engine, target list, and date; routine CI
runs fixtures, not these registry scans. Scope: [docs/benchmark.md](../docs/benchmark.md#scope-of-the-claim-read-this-first).

## 2026-10-05 revalidation after engine hardening

The same 1,000 July-pinned npm targets were rescanned using revision
`3007a72d5ebd4d7957d38d5c429a7dd71fe85e09`. In 625 seconds, 989 attempts returned
verdicts: **174 ALLOW, 780 REVIEW, and 35 BLOCK**. The remaining **11 attempts
timed out** at 40 seconds. All 35 blocks carried known-vulnerability findings;
there were zero unadjudicated heuristic block candidates. The completion and
candidate gates passed, which is not an accuracy or completeness claim.

Review burden was **780/989 (78.87%)** of scans returning verdicts. The dominant
review categories were flow-analysis gaps (651 packages), incomplete source
scans (376), and unresolved runtime execution (318). Categories overlap. These
findings expose unresolved analysis work; they must not be removed merely to
lower the review rate. A returned report can still contain incomplete analysis.

The [aggregate baseline](baselines/2026-10-05-npm.json) records the scan's engine
build, revision, runner and input hashes, UTC start time, error breakdown, and
70 review groups. Retained citations were complete for 437 reviewed packages,
partial for 326, and unavailable for 17; this measures citation availability,
not scanner coverage. Human review time remains unmeasured. Raw package records
and source citations remain local.

This run occurred on October 5 in `America/Vancouver` and October 6 in UTC; both
are recorded. The October 4 result below used an earlier engine and remains a
separate historical baseline. These figures do not establish a causal accuracy
improvement or describe a refreshed popularity ranking.

## 2026-10-04 revalidation of the pinned npm cohort

The updated harness completed all 1,000 July-pinned targets in 143 seconds:
732 SAFE, 239 REVIEW, and 29 known-vulnerability BLOCK verdicts, with zero scan
errors and zero unexplained heuristic block candidates. Review burden was
23.9% of successful scans; human resolution time was not measured.

The [aggregate baseline](baselines/2026-10-04-npm.json) records the engine and
input hashes, command, completion gate, and review reasons. These are the July
targets rescanned in October, not an updated popularity ranking. Live
vulnerability and repository metadata can change verdicts; this run did not
retune any detector and does not establish a causal improvement over July.
Historical website artifacts remain unchanged.

## 2026-07-19 revalidation (historical)

The earlier run below ranked by **depended-upon count** from a fixed
[2019-ish gist](https://gist.github.com/anvaka/8e8fa57c7ee1350e3491). A fresh run
ranked the top-1000 by **real last-week download counts** (npmrank pool →
`api.npmjs.org/downloads`) as of 2026-07-19:

| metric | result |
|---|---|
| packages scanned | 1000 |
| **heuristic false blocks** | **0** (after the retune below) |
| correct known-CVE blocks | 3 — `elliptic@6.6.1`, `request@2.88.2`, `xlsx@0.18.5` |
| review / safe / scan-error | 661 / 334 / 1 |

**One false block was surfaced and fixed.** `registry-url@7.2.0` (100M+
downloads/wk) blocked on `credential-access` — it reads `.npmrc` **only** to
parse the `registry` URL, with no `_authToken` reference and no network egress.
Root cause of the miss: this package was **not in the depended-upon list** the
earlier validation used, so the `.npmrc` heuristic (which predates that run) was
never exercised against it. Fix: an `.npmrc` read with no auth-field reference
and no network sink is now `INFO`, not a block; `registry-url` is a committed
benign fixture (`benchmark/corpus/benign/npmrc-read-for-registry-url.json`) so
the gate covers it. **Lesson: rank the validation list by the metric the claim
is about (downloads), and refresh it — a stale list hides real false blocks.**

**Review burden:** 661 of 1,000 targets received REVIEW. The run did not measure
how long resolving these findings took, so zero heuristic false blocks must not
be read as zero manual work. New reports use successful scans as the review-rate
denominator and report failures separately.

The full per-package results for this run live in the batch-scan workspace
(`~/pkgxray-scan/results/top1000/`) with the calibration writeup at
`~/pkgxray-scan/reports/calibration.md`.

## Earlier run (2026-07-11, depended-upon snapshot — history)

The earlier run used the most-depended-upon snapshot. It is retained as history
and does not describe the current default target list.

## Run it

```bash
node scripts/validate-at-scale.js                 # pinned July 2026 npm top-1000
node scripts/validate-at-scale.js --limit 100     # quick sample
node scripts/validate-at-scale.js --concurrency 8 --timeout-ms 40000
```

Outputs to `validation/results/`:

- `report.md` — human-readable summary (the headline table + any false blocks)
- `results.jsonl` — one JSON record per package (decision, grade, findings, timing)
- `summary.json` — completion gate, separate successful/error counts, heuristic
  block candidates, and review burden
- `review-queue.json` — local per-package REVIEW findings, source citations,
  pinned identities when available, and suggested review steps grouped by exact
  category combinations. Keep this file private; CI uploads aggregates only.

Exit code is `0` only when every requested scan is recorded, at least one scan
succeeds, at most 10% of attempted scans fail, and no unadjudicated heuristic
block candidates remain. A timeout-only or empty run fails even if it reports
zero blocks. Error thresholds apply whether or not `--emit-stats` is used.

`reviewBurden` reports the REVIEW count, successful-scan denominator, rate, and
finding categories counted once per reviewed package. Resolution time is `null`
until measured with human reviewers. A rate without a denominator is unmeasured,
not zero or 100%.

`reviewWorkflow` groups each reviewed package once, even if it has many findings.
It records how many packages have complete, partial, or unavailable citations.
This describes the retained citations, not completeness of the scanner's
behavioral analysis. Older saved results may contain categories without source
citations; rescan the exact versions before deciding whether those findings are
unnecessary. Grouping never approves a package or changes its verdict.

### Review-burden work plan

1. Revalidate the pinned cohort whenever the engine changes and record its build
   identity. Keep earlier results rather than overwriting them.
2. Start with the largest single-category groups, then inspect mixed-category
   cases. Review each package version and the cited source separately; a common
   install hook or a popular package is not sufficient evidence to clear it.
3. Record each human disposition and elapsed review time. Compare verdicts and
   review effort on the same inputs before calling a change an improvement.
4. Capture confirmed benign misclassifications in inert regression evidence,
   then make a narrow detector correction and rerun retained cohort gates.

The October 4 baseline's 239 reviews are historical observations. The current
work improves review organization and evidence retention; no reduction in the
review rate or human resolution time has yet been demonstrated.

The manual [registry validation workflow](../.github/workflows/pkgxray-validation.yml)
accepts npm, PyPI, MCP, or all cohorts. Each cohort gets separate fixture and
registry summaries using the committed target list. Aggregate artifacts are
retained for review; the workflow does not publish them to the stats site.

## MCP cohort (separate figures, never merged)

The published calibration numbers are npm-centric, and the README concedes the
MCP/agent-tooling ecosystem is over-blocked without giving a number. This
cohort exists to measure that number — **separately**. MCP results live in
their own out-dir and their own stats artifact; they are never folded into the
top-1000 / npm figures.

The target list comes from the **official MCP Registry**
(`registry.modelcontextprotocol.io`). It holds latest versions of active servers,
npm packages only, with duplicates removed, and it is sized for one scan pass.
Entries are collected in registry cursor order up to the cap, because the
registry has no download ranking, and the file is sorted by identifier so diffs
stay stable. It records inputs only, names and versions, and no verdicts:

- [`mcp-registry-targets.txt`](mcp-registry-targets.txt) — the list
- [`mcp-registry-targets.meta.json`](mcp-registry-targets.meta.json) — source,
  fetch date, counts, regeneration command

```bash
node scripts/build-mcp-target-list.js       # refresh the list from the registry

node scripts/validate-at-scale.js \
  --cohort mcp --list validation/mcp-registry-targets.txt \
  --emit-stats validation/results/mcp/stats.json --run-id $(date +%F)-mcp
```

Results land in `validation/results/mcp/` (report + jsonl as above). The
`--emit-stats` artifact has the exact shape of `website/stats/data/<runId>.json`:
heuristic block candidate figures from the scan, catch-rate figures from
`node benchmark/run.js --json --cohort mcp` (fixtures tagged `"cohort": "mcp"`
in the committed corpus). A cohort with no malicious fixtures has unmeasured
recall (`null` / `N/A`), not 100%; a small denominator is not evidence of broad
coverage. Stats emission requires both a passing scan-completion gate and a
successful benchmark. Nothing publishes automatically: review the artifact by hand, then copy it into
`website/stats/data/` and rebuild the stats site.

## What counts as a false block

A `block` decision is a **false block** only when it is heuristic-driven on a
genuinely benign package. Popularity alone is not a benign ground-truth label.
The harness therefore reports unexplained heuristic blocks as **candidates**
that fail the gate pending review. Three classes are reported separately:

- **known-CVE blocks** — the package has a published OSV vulnerability. Blocking
  it is correct; pkgxray must never allow a published vuln away.
- **defensible blocks** — the package genuinely performs the flagged high-risk
  operation (see [`defensible-blocks.json`](defensible-blocks.json); e.g. `pm2`
  installs systemd/init boot persistence via its documented `pm2 startup`
  feature). These are true positives a security team *should* review. The list
  is committed and audited — it must never be used to hide a real false positive.
- **errors** — the package no longer resolves (unpublished/renamed since the
  corpus snapshot). Recorded as `error`, never as a block.

`review` is **not a false block**. It can still be unnecessary work, so its
count, rate, and reasons are reported separately. It is the middle tier for
governance and provenance signals: a single maintainer, missing provenance, a
build artifact that diverges from git, a dual-use URL shortener in an error link,
and so on.

## The corpus

The default npm target list is the committed
[`2026-07-19 top-1000`](calibration-2026-07-19/top1000-targets.txt), with pinned
package versions. The older [`most-depended-upon snapshot`](../src/data/top1000.txt)
remains available with `--list` for historical comparisons. These lists do not
automatically track today's popularity ranking. PyPI uses its separate
[`target list`](top-pypi-1000.txt); MCP uses the registry list above.
Unresolvable packages are recorded as errors, never as successful scans.

## Feeding results back into the engine

Every genuine false block this surfaces becomes a **benign fixture** in
`benchmark/corpus/benign/`, so the calibration gate in CI locks the fix in
permanently. The top-1000 run that prompted this harness turned up 22 false
blocks across about 7 detectors:

- dual-use link shorteners
- shell-completion installers
- transform test fixtures
- a decode and an `eval` sitting together in a minified bundle
- build artifacts that diverge from git
- example IPs and license URLs in comments
- deleted repos

Each one was calibrated and captured as a regression fixture.
