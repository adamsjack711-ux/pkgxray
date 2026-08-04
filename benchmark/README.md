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
| `XFAIL` | a `knownFalsePositive` fixture that still mis-verdicts (documented misfire, not yet retuned) | tracked, **non-gating** |
| `XPASS` | a `knownFalsePositive` fixture that now behaves correctly → drop the marker | reported |

A fixture marked `"knownFalsePositive": true` is a confirmed heuristic misfire — a
benign shape the engine wrongly blocks/over-flags today, captured so it is never
lost, but **without** hard-failing unrelated CI. It shows as `XFAIL` until the
responsible heuristic is deliberately retuned; when the fix lands it becomes
`XPASS`, and the marker (and this exemption) should be removed so the case is
enforced by the hard gate like any other benign fixture. This keeps known-FP debt
visible and honest rather than either breaking the gate or silently relabelling
the sample as `safe`.

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
  "knownFalsePositive": true,                 // optional: documented misfire → XFAIL, non-gating (benign only)
  "cohort": "pypi",                           // optional: ecosystem tag (default "npm"); enables --cohort pypi
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
`child_process` alone in a test file, npm↔GitHub divergence, a legitimate geoip
lookup, a CI-detecting postinstall — so a recalibration that starts blocking
them fails CI.

### Real-world advisory samples

The `advisory-*` fixtures are modeled on documented npm supply-chain incidents,
each reduced to the smallest source that still trips the finding:
`event-stream`/`flatmap-stream` (stage-2 loader, 2018), `node-ipc`/`peacenotwar`
(geo-gated file corruption, 2022), `crossenv` (typosquat env-exfil, 2017),
`eslint-scope` (`.npmrc` token theft, 2018), `ua-parser-js` (preinstall dropper,
2021), `@solana/web3.js` (wallet key exfil, 2024), a torchtriton-style
dependency-confusion recon payload (2023), and a Unicode-tag ASCII-smuggling
injection. Building these paid off immediately: the `node-ipc` sample exposed a
real gap — the logic-bomb detector caught file *deletion* but not the in-place
*overwrite* corruption that node-ipc actually used, so the sample passed with
zero behavioral findings. That gap is now closed (see `inspectLogicBomb`).

Two samples are intentional **under-flags** the benchmark documents rather than
hides: a bare `curl | sh` to an unknown host and the `node-ipc` geo-bomb both
reach `review`, not `block`, because pkgxray routes download-then-execute and
geo/locale-gated destructive ops to a human by policy (see the
[severity policy](../docs/reference.md#severity-policy-what-lands-in-block--review--info)).

### Cohorts (npm vs PyPI)

Every fixture belongs to a **cohort** — its ecosystem — via an optional
`"cohort"` field that defaults to `"npm"`. The no-flag `npm run benchmark` run
(what CI gates on) includes **all** cohorts, so the floor and false-block gates
cover npm and PyPI together. `--cohort pypi` runs only the PyPI fixtures for a
focused read; the recall floor is skipped under a cohort filter because the
committed floor is defined over the full corpus.

PyPI fixtures author the `evidence` bundle the same way, with two differences:

- **The manifest is `setup.py` / `pyproject.toml`, not `package.json`.** A
  malicious PyPI fixture is a `setup.py` that does more than declare metadata —
  the sdist-dropper shape (`exec`/`eval`/`compile`/`__import__` over a
  base64/marshal/zlib-decoded or network-fetched payload) blocks with a
  `code-execution` finding; a generic install hook (subprocess / custom
  `cmdclass` / in-tree `backend-path`) reviews.
- **`npmMetadata` uses the PyPI-mapped shape** (`pypiMetadataForEvidence`):
  `repository` from `project_urls`, `maintainers` from `ownership.roles`,
  `deprecated` from `yanked`. Give a benign fixture a repository + ≥2
  maintainers so no governance signal fires.

Do **not** add a payload-in-a-plain-`.py`-module malicious PyPI fixture: the
shared behavioral engine's obfuscation/exec-network detectors are still
JS-primitive-shaped, so `exec(marshal.loads(...))` outside `setup.py` is a
documented v1 blind spot — such a fixture would be a MISS hard-fail. That parity
work is tracked for a later release.

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
