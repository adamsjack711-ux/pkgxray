# Upgrade finding comparisons

`pkgxray recheck package-lock.json --format json` now includes a compact
`securityChanges` object for each newer-version candidate. It compares the
candidate scan with the pinned version's **fresh scan from the same run**. The
stored verdict in `.pkgxray.lock` still serves the separate verdict-drift check;
it is not used as finding evidence.

For example, two releases can both return REVIEW while the newer one adds a
remote-code loading finding alongside an existing install hook. The comparison
shows the new category, severity, file, occurrence count and evidence fingerprint
instead of reducing both releases to the same verdict.

## Output and interpretation

- `status: "compared"`: both finding lists are valid, source and vulnerability
  checks completed, behavioral coverage completed with no mandatory holds,
  and scanner build, policy hash and check states match. A completed file scan
  alone does not establish completed behavioral analysis. An explicit approval
  override does not erase a coverage gap for this comparison.
- `status: "partial"`: finding lists can be compared, but scan completion or
  context cannot be established. New observations remain visible, while
  `notObserved` and its count are `null`.
- `status: "unavailable"`: at least one finding list is missing, malformed, or
  beyond the comparison budget. No empty-list safety claim is made.
- `added`: findings not present in the pinned scan, or additional occurrences.
- `notObserved`: prior findings absent in the candidate's comparable scan.
  **This does not mean a vulnerability was resolved.** Scanner silence is not
  proof of remediation.
- `limitations`: explicit reasons why a complete comparison cannot be claimed.
- `counts` and `truncated`: total finding-instance changes and whether detail
  lists were capped at 50 entries per direction.

Identity uses exact category, severity, file and cited snippet bytes. Line
numbers, report order and rationale wording are excluded. Repeated findings
retain their counts; severity changes appear as a new observation. Snippets are
hashed and omitted from the compact output, so it does not copy source commands
into the summary. Terminal text sanitizes control characters in finding fields.

This is a comparison of **scanner observations**, not a source-code semantic
diff. File renames or changed excerpts can appear as removed and added evidence.
It does not track a finding across renames, compare dependency graphs, or prove
that matching findings describe identical behavior. Optional checks that were
not requested remain outside the compared scope. The existing npm-versus-GitHub
archive comparison is a separate feature.

The comparison never authorizes installation, overrides a verdict, applies a
triage decision, or executes package code. A candidate with no added findings
can still be BLOCK or REVIEW. A known risk is retained even if another candidate
fails to scan. Mixed SAFE and unknown candidates are reported as incomplete,
not as an all-clean upgrade. `--fail-on-available-updates` returns REVIEW/exit 3
for incomplete vetting and BLOCK/exit 2 when any candidate is known blocked.
Without that option, upgrade vetting remains informational.

## Regression calibration

Run:

```bash
node benchmark/upgrade-diff.js
node --test test/upgrade-diff.test.js test/recheck-version-drift.test.js
```

The committed corpus in `benchmark/upgrade-corpus.json` contains ten
maintainer-authored synthetic before/after pairs. The real static engine scans
the inert evidence, and the upgrade comparator processes its findings. Cases
cover an added or removed install hook, newly cited credential access, remote
shell loading, an unchanged hook, arithmetic changes, an ordinary HTTP client,
and a comment lookalike. Calibration expects explicit medium/high category
changes and reports missed or unexpected added signals; any case mismatch
fails the command and the normal test suite.

The corpus is **not independently labelled**, not a malware prevalence sample,
and not a measurement of overall scanner precision or recall. The benchmark
uses synthetic matching assessment context solely to exercise the comparison;
it makes no network requests and produces no real approval receipts. Separate
unit tests cover failed and mismatched scan contexts, malformed reports,
duplicate findings, output budgets and a mixed SAFE/unknown upgrade result.
