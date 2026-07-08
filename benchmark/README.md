# pkgxray calibration benchmark

A committed corpus of **labelled fixtures** run through the real static engine
(`auditEvidence` — no network, no execution) to make pkgxray's calibration
claims reproducible and regression-gated. This is what turns "validated with 0
false blocks" from a sentence in the README into a check that fails CI the day
it stops being true.

```bash
npm run benchmark            # human report; exit 1 on a hard failure
node benchmark/run.js --json # machine-readable summary for CI
node benchmark/run.js --verbose  # list every case and its outcome
```

## What it measures

Each fixture is labelled with the verdict a security reviewer considers correct
(`expect`). The runner compares that to the engine's actual verdict and buckets
the outcome:

| Outcome | Meaning | Gate |
|---|---|---|
| `CORRECT` | actual === expect | — |
| `FALSE_BLOCK` | benign (`safe`/`review`) fixture came back `block` | **hard fail** |
| `MISS` | malicious (`block`) fixture came back `safe` | **hard fail** |
| `OVER_FLAG` | `safe` fixture came back `review` (stricter than needed) | warn |
| `UNDER_FLAG` | caught but under-classified (e.g. `block` → `review`) | warn |

The gate deliberately fails on only the two outcomes that carry real cost — a
false block (the reputational risk pkgxray is built to avoid) and a full miss
(malware that passed) — and tolerates benign calibration drift, because the
detection engine is *expected* to get stricter over time. It also reports block
**precision** (of everything blocked, how much is truly malicious) and **recall**
(of malicious fixtures, how much got blocked) so a change that trades one for the
other is visible.

Under-flags are surfaced, not hidden: e.g. a bare `curl | sh` to an unknown host
is ground-truth malicious but pkgxray routes it to `review` (not `block`) by
policy. The benchmark shows that as an `UNDER_FLAG` rather than quietly relabelling
it — an honest calibration corpus documents the engine's real edges.

## Corpus layout

```
corpus/malicious/*.json   ground-truth-malicious samples (expect: block)
corpus/benign/*.json      known-good shapes, incl. the documented FP-traps
```

Each file is one case:

```jsonc
{
  "name": "env-exfil-to-webhook",
  "expect": "block",                       // security-correct verdict for this input
  "expectFinding": "network-exfil-or-loader", // optional: a finding category that must be present
  "note": "process.env POSTed to a hardcoded webhook",
  "evidence": {                            // passed verbatim to auditEvidence()
    "packageName": "helper-utils",
    "sourceFiles": { "index.js": "…" }     // path -> content, same shape the CLI builds
  }
}
```

The benign corpus intentionally includes the false-positive traps pkgxray is
tuned against — `eval` on a string literal (bundler wrapper), `new
Function("return this")`, a URL shortener in prose with no capability,
`child_process` alone in a test file, npm↔GitHub divergence — so a
recalibration that starts blocking them fails CI.

## Adding a case

1. Drop a JSON file in `corpus/malicious/` or `corpus/benign/`.
2. Set `expect` to the verdict a reviewer would assign the *sample* (not
   necessarily what the engine does today — an honest label lets an under-flag
   show up as a warning).
3. Run `npm run benchmark`. A new benign case must never hard-fail; a new
   malicious case that only reaches `review` is a warning worth a `note`.

Real-world tarballs are the best source of new fixtures — reduce a known-malicious
package to the smallest source that still trips the finding, and add a benign
counterpart that looks similar but shouldn't gate.
