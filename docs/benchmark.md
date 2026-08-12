# Benchmarks & calibration

pkgxray's central calibration claim is **0 heuristic false blocks on the
top-1000 most-downloaded npm packages**. It is not just a sentence in the README.
It is a committed corpus and a CI gate that fails the day it stops being true.

## Scope of the claim (read this first)

Two claims are easy to mix up. pkgxray makes only the first:

- ✅ **"0 heuristic false blocks on the top-1000 most-downloaded packages."** A
  block driven by a malware heuristic (not a known CVE) on a mainstream,
  widely-installed package. This is measured, gated, and true (see the
  2026-07-19 revalidation below).
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
| `UNDER_FLAG` | caught but under-classified (e.g. `block` → `review`) | warn |

The gate fails on only the two outcomes that carry real cost: a false block and a
full miss. It tolerates benign calibration drift, because the detection engine is
*expected* to get stricter over time. It also reports block **precision** and
**recall**, so a change that trades one for the other is visible.

For the full methodology, the corpus layout, and an honest account of
under-flags, see [`benchmark/README.md`](../benchmark/README.md).

## Real-world validation

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

## Performance

[reference.md#performance](reference.md#performance) documents the timings: guard
wall-clock, proxy gate overhead, and result-scan cost. The headline numbers are
~25 ms for local static analysis, and ~1.3 to 1.5 s for a full `guard` of a
popular package on a cold cache, which is almost all network round-trips.
