# Benchmarks & calibration

pkgxray's central calibration claim — **0 false blocks** on the most-installed
npm packages — is not a sentence in the README; it is a committed corpus and a
CI gate that fails the day it stops being true.

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
| `UNDER_FLAG` | caught but under-classified (e.g. `block` → `review`) | warn |

The gate deliberately fails on only the two outcomes that carry real cost — a
false block and a full miss — and tolerates benign calibration drift, because
the detection engine is *expected* to get stricter over time. It also reports
block **precision** and **recall** so a change that trades one for the other
is visible.

Full methodology, corpus layout, and the honest treatment of under-flags:
[`benchmark/README.md`](../benchmark/README.md).

## Real-world validation

- **Top-47**: the 47 most-installed npm packages, 0 false blocks (the
  regression harness lives at `scripts/popular-scan.sh`).
- **Top-1000**: a full top-1000 validation run with results and per-package
  report at [`validation/`](../validation/).

## Performance

Timings (guard wall-clock, proxy gate overhead, result-scan cost) are
documented in [reference.md#performance](reference.md#performance). Headline:
local static analysis is ~25 ms; a full `guard` of a popular package is
~1.3–1.5 s cold-cache, almost all of it network round-trips.
