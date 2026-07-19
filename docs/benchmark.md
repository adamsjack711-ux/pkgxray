# Benchmarks & calibration

pkgxray's central calibration claim — **0 heuristic false blocks on the top-1000
most-downloaded npm packages** — is not a sentence in the README; it is a
committed corpus and a CI gate that fails the day it stops being true.

## Scope of the claim (read this first)

Two different claims are easy to conflate; pkgxray makes only the first:

- ✅ **"0 heuristic false blocks on the top-1000 most-downloaded packages."** A
  block driven by a malware heuristic (not a known CVE) on a mainstream,
  widely-installed package. This is measured, gated, and true (see the
  2026-07-19 revalidation below).
- ❌ **"0 false blocks in the wild, on any package."** pkgxray does *not* claim
  this. A 2026-07-19 scan of 300 MCP-ecosystem packages found the heuristics
  over-block that newer, niche space (packages that ship their own `.mcp.json`,
  read `.npmrc`/`.env` for config, spawn processes, or quote injection strings
  in defensive docs). Those false positives are tracked and reconciled per-case
  — 6 heuristics narrowed so far, the rest recorded as calibration debt — but
  the "0 false blocks" claim is explicitly **scoped to the most-installed set**,
  not the whole registry.

**Why the top-1000 number is trustworthy even though a real-world FP surfaced:**
the pre-2026-07-19 top-1000 validation ran against a stale (2019-snapshot) list
that did not include `registry-url` — so the `.npmrc` credential-access
heuristic *could* false-block it, but the corpus never exercised that package. A
fresh top-1000 (ranked by real 2026 download counts) surfaced it, the heuristic
was narrowed (an `.npmrc` read with no auth-field reference and no network sink
is now INFO, not a block), and `registry-url` is now a committed benign fixture
so the gate covers it permanently. Lesson: a calibration claim is only as good
as the freshness and coverage of the list it is validated against.

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
- **Top-1000 (2026-07-19 revalidation)**: 1,000 packages ranked by **real
  last-week download counts** (not a stale snapshot). Result: **0 heuristic
  false blocks**, 3 correct known-CVE blocks (`elliptic` CVE-2024…, `request`
  SSRF, `xlsx` prototype-pollution/ReDoS). The single heuristic false block the
  run first surfaced (`registry-url`, `.npmrc`→registry-URL read) was narrowed
  and committed as a benign fixture. Fresh summary: [`validation/README.md`](../validation/README.md).
- **Top-1000 (earlier snapshot)**: prior run at [`validation/`](../validation/)
  — retained for history; superseded by the 2026-07-19 revalidation above.
- **MCP ecosystem (2026-07-19, 300 packages)**: NOT covered by the "0 false
  blocks" claim — the heuristics over-block here; false positives are tracked
  and reconciled per-case. This is the honest boundary of the calibration.

## Performance

Timings (guard wall-clock, proxy gate overhead, result-scan cost) are
documented in [reference.md#performance](reference.md#performance). Headline:
local static analysis is ~25 ms; a full `guard` of a popular package is
~1.3–1.5 s cold-cache, almost all of it network round-trips.
