# Benchmarks & calibration

The **2026-07-19 top-1000 npm validation** recorded **0 heuristic false
blocks after retuning**. This historical registry run and the committed fixture
benchmark measure different things: routine CI reruns the fixtures, not all
1,000 live packages.

## Scope of the claim (read this first)

Two claims are easy to mix up. pkgxray makes only the first:

- ✅ **"0 heuristic false blocks on the top-1000 most-downloaded packages."** A
  block driven by a malware heuristic (not a known CVE) on a mainstream,
  widely-installed package. This was measured in the
  2026-07-19 revalidation below; it is not a current-engine guarantee.
- ❌ **"0 false blocks in the wild, on any package."** pkgxray does *not* claim
  this. A 2026-07-19 scan of 300 MCP-ecosystem packages found that the
  heuristics over-block in that newer, niche space. The packages that trip them
  ship their own `.mcp.json`, read `.npmrc` or `.env` for config, spawn
  processes, or quote injection strings in defensive docs. Those false positives
  are tracked and reconciled case by case: 6 heuristics narrowed so far, and the
  rest recorded as calibration debt. The "0 false blocks" claim is **scoped to
  the most-installed set**, not the whole registry.

**Why the top-1000 number holds up even though a real false positive surfaced.**
The top-1000 validation before 2026-07-19 ran against a stale list, a 2019
snapshot that did not include `registry-url`. The `.npmrc` credential-access
heuristic could have false-blocked that package, but the corpus never exercised
it. A fresh top-1000, ranked by real 2026 download counts, surfaced it. The
heuristic was then narrowed, so an `.npmrc` read with no auth-field reference and
no network sink is now INFO rather than a block, and `registry-url` is a
committed benign fixture that the gate covers permanently. The lesson: a
calibration claim is only as good as the freshness and coverage of the list
behind it.

## The calibration benchmark

A labelled corpus of malicious and benign fixtures is run through the real
static engine (`auditEvidence` — no network, no execution) on every change:

```bash
npm run benchmark                 # human report; exit 1 on a hard failure
node benchmark/run.js --json      # machine-readable summary for CI
node benchmark/run.js --verbose   # list every case and its outcome
```

| Outcome | Meaning | Gate |
|---|---|---|
| `CORRECT` | actual === expected | — |
| `FALSE_BLOCK` | benign fixture came back `block` | **hard fail** |
| `MISS` | malicious fixture came back `safe` | **hard fail** |
| `OVER_FLAG` | `safe` fixture came back `review` (stricter than needed) | warn |
| `UNDER_FLAG` | expected `review` becomes `safe`, or a documented `knownUnderflag` becomes `review` instead of `block` | warn |
| `RECALL_DROP` | another expected `block` case reaches `review` | **hard fail** |
| `COVERAGE_DROP` | retained evidence for a cohort falls below its committed minimum | **hard fail** |

The gate rejects false blocks and full misses, with explicitly tracked
known-false-positive exemptions, and enforces the committed full-corpus recall
floor. New block-to-review regressions also fail; documented `knownUnderflag`
cases and benign REVIEW outcomes remain visible as warnings.
Block **precision** includes documented false positives; **recall** counts
malicious fixtures that were blocked. A metric with no denominator is `null`
in JSON and `N/A` in the report, never 100%. Results include separate npm, PyPI,
and MCP cohort measurements so an empty or small cohort cannot inherit
confidence from the combined corpus.

Per-cohort retention gates now protect the malicious, benign, and blocking
counts recorded in the [2026-10-04 fixture baseline](../benchmark/baselines/2026-10-04.json).
Previously, npm alone could satisfy the full-corpus blocking floor even if all
PyPI fixtures disappeared. The default benchmark now rejects that loss of
evidence. A cohort-filtered run checks only that cohort. Passing these gates
means existing evidence was retained; it does not mean coverage is sufficient.

For the full methodology, the corpus layout, and an honest account of
under-flags, see [`benchmark/README.md`](../benchmark/README.md).

## Evaluation gaps and next work

The [post-integration fixture baseline](../benchmark/baselines/2026-10-05.json)
contains 72 cases: 31 malicious-labelled and 41 benign. Thirty malicious cases
BLOCK and one requires REVIEW; none are SAFE, and no benign case BLOCKs.
However, 22 of 41 benign cases require REVIEW, including all seven PyPI benign
fixtures. These are corpus results, not registry-wide accuracy measurements.

The [new engine's pinned npm run](../validation/baselines/2026-10-05-npm.json)
returned 780 REVIEW verdicts among 989 completed reports, with 11 timeouts.
Flow-analysis gaps (651 packages), source-collection gaps (376), and unresolved
runtime execution (318) overlap and dominate the workload. Prioritize tracing
missing runtime targets and flow-budget exhaustion, including whether references
to unpublished development scripts are being treated as installed runtime roots.
Keep actual runtime/lifecycle uncertainty visible while investigating. The
private review queue supplies per-package citations; the aggregate does not
establish that these reviews are unnecessary.

The recorded October 4 calibration contains 25 malicious and 32 benign npm
fixtures, 5 malicious and 7 benign PyPI fixtures, and one benign MCP fixture.
These counts describe that recorded checkout, not a later engine or upstream
corpus. Re-run after integrating detector or corpus changes and record a new
engine and corpus fingerprint; do not replace the old baseline's measurements.

1. **Keep detection evidence separate from gate status.** MCP recall remains
   unmeasured without malicious-labelled evidence. The runner now reports the
   missing class explicitly. PyPI's five malicious examples cover installation
   manifests; they do not establish general Python behavioral coverage. Keep
   these limitations alongside results, including passing CI runs.
2. **Strengthen label review before claiming broader coverage.** Have a reviewer
   assess existing inert examples independently of their observed verdicts.
   Record provenance, expected behavior, ecosystem, and the behaviors actually
   exercised. Treat related variants as correlated examples, and keep calibration
   and separately held evaluation sets distinct.
3. **Measure benign operational behavior.** Use existing inert fixtures and
   successful benign package archives to check evidence collection, incomplete
   scans, manifest handling, and review decisions for each ecosystem. Report
   missing evidence explicitly rather than interpreting a completed scan as
   complete behavioral coverage.
4. **Measure review cost.** Alongside the proportion sent to REVIEW, use a
   documented human-review sample to record resolution time and disposition.
   Fixture review rates and live-package review rates use different denominators
   and must remain separate.

Increasing fixture counts alone cannot complete this plan. Independent labels,
representative benign inputs, retained failures, and explicit scope are required
before making broader accuracy claims.

## Real-world validation

- **Pinned npm cohort (2026-10-04 revalidation):** all 1,000 July-pinned
  targets completed with no errors: 732 SAFE, 239 REVIEW, 29 known-vulnerability
  blocks, and zero unexplained heuristic block candidates. Review burden was
  23.9%; resolution time remains unmeasured. This is a new run of historical
  inputs, not a fresh popularity ranking. See the
  [aggregate baseline](../validation/baselines/2026-10-04-npm.json).

- **Top-47**: the 47 most-installed npm packages, 0 false blocks (the
  regression harness lives at `scripts/popular-scan.sh`).
- **Top-1000 (2026-07-19 revalidation)**: 1,000 packages ranked by **real
  last-week download counts**, not a stale snapshot. Result: **0 heuristic
  false blocks**, and 3 correct known-CVE blocks (`elliptic` CVE-2024…, `request`
  SSRF, `xlsx` prototype-pollution and ReDoS). The run first surfaced one
  heuristic false block, `registry-url`, which reads `.npmrc` for a registry URL.
  That heuristic was narrowed and the package committed as a benign fixture.
  Fresh summary: [`validation/README.md`](../validation/README.md).
- **Top-1000 (earlier snapshot)**: an earlier run at
  [`validation/`](../validation/), kept for history. The 2026-07-19 revalidation
  above supersedes it.
- **MCP ecosystem (2026-07-19, 300 packages)**: NOT covered by the "0 false
  blocks" claim. The heuristics over-block here, and the false positives are
  tracked and reconciled case by case. This is the honest boundary of the
  calibration.

The July npm run also recorded **661 REVIEW verdicts out of 1,000 targets**.
A low false-block rate does not imply a low review burden. New validation
reports include the REVIEW count and rate among successful scans, reasons for
review, and an explicitly unmeasured resolution time until a timed human review
is performed. Scan failures are reported separately and cannot be counted as
successfully cleared packages.

The manual [registry validation workflow](../.github/workflows/pkgxray-validation.yml)
runs the chosen cohort(s) against committed target lists and retains aggregate
results for review; it does not publish new calibration claims automatically.
See [validation instructions](../validation/README.md) for local runs and the
completion/error gates. Neither the fixed target lists nor the historical
results establish coverage of the current entire registry.

## Performance

[reference.md#performance](reference.md#performance) documents the timings: guard
wall-clock, proxy gate overhead, and result-scan cost. The headline numbers are
~25 ms for local static analysis, and ~1.3 to 1.5 s for a full `guard` of a
popular package on a cold cache, which is almost all network round-trips.
