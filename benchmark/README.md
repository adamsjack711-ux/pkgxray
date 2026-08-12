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

A fixture marked `"knownFalsePositive": true` is a confirmed heuristic misfire: a
benign shape the engine wrongly blocks or over-flags today. Capturing it means
the case is never lost, and it does not hard-fail unrelated CI. It shows as
`XFAIL` until someone retunes the heuristic behind it. When the fix lands it
becomes `XPASS`, and you should remove both the marker and this exemption, so the
hard gate enforces the case like any other benign fixture. That keeps known
false-positive debt visible instead of breaking the gate or quietly relabelling
the sample as `safe`.

The gate fails on only the two outcomes that carry real cost: a false block,
which is the reputational risk pkgxray is built to avoid, and a full miss, which
is malware that passed. It tolerates benign calibration drift, because the
detection engine is *expected* to get stricter over time. It also reports block
**precision**, meaning how much of everything blocked is truly malicious, and
**recall**, meaning how many malicious fixtures got blocked. That way a change
that trades one for the other is visible.

Under-flags are surfaced, not hidden. A bare `curl | sh` to an unknown host is
malicious by ground truth, but policy routes it to `review` rather than `block`.
The benchmark shows that as an `UNDER_FLAG` instead of quietly relabelling it. An
honest calibration corpus documents where the engine's real edges are.

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

The benign corpus deliberately includes the false-positive traps pkgxray is tuned
against: `eval` on a string literal (a bundler wrapper), `new
Function("return this")`, a URL shortener in prose with no capability,
`child_process` alone in a test file, npm↔GitHub divergence, a legitimate geoip
lookup, and a postinstall that detects CI. A recalibration that starts blocking
any of them fails CI.

### Real-world advisory samples

The `advisory-*` fixtures are modeled on documented npm supply-chain incidents.
Each is cut down to the smallest source that still trips the finding:

- `event-stream` and `flatmap-stream` (stage-2 loader, 2018)
- `node-ipc` and `peacenotwar` (geo-gated file corruption, 2022)
- `crossenv` (typosquat env exfiltration, 2017)
- `eslint-scope` (`.npmrc` token theft, 2018)
- `ua-parser-js` (preinstall dropper, 2021)
- `@solana/web3.js` (wallet key exfiltration, 2024)
- a torchtriton-style dependency-confusion recon payload (2023)
- a Unicode-tag ASCII-smuggling injection

Building these paid off immediately. The `node-ipc` sample exposed a real gap:
the logic-bomb detector caught file *deletion* but not the in-place *overwrite*
corruption that node-ipc actually used, so the sample passed with zero
behavioral findings. That gap is now closed. See `inspectLogicBomb`.

Two samples are **under-flags** on purpose, and the benchmark documents them
rather than hiding them. A bare `curl | sh` to an unknown host and the `node-ipc`
geo-bomb both reach `review` rather than `block`, because policy routes
download-then-execute and destructive operations gated on region or locale to a
person. See the
[severity policy](../docs/reference.md#severity-policy-what-lands-in-block--review--info).

### Cohorts (npm vs PyPI)

Every fixture belongs to a **cohort**, meaning its ecosystem, set by an optional
`"cohort"` field that defaults to `"npm"`. Running `npm run benchmark` with no
flags is what CI gates on, and it includes **all** cohorts, so the floor and
false-block gates cover npm and PyPI together. `--cohort pypi` runs only the PyPI
fixtures for a focused read. A cohort filter skips the recall floor, because the
committed floor is defined over the full corpus.

PyPI fixtures author the `evidence` bundle the same way, with two differences:

- **The manifest is `setup.py` or `pyproject.toml`, not `package.json`.** A
  malicious PyPI fixture is a `setup.py` that does more than declare metadata.
  The sdist-dropper shape blocks with a `code-execution` finding: `exec`, `eval`,
  `compile`, or `__import__` over a payload that was decoded from base64,
  marshal, or zlib, or fetched over the network. A generic install hook reviews
  instead: a subprocess, a custom `cmdclass`, or an in-tree `backend-path`.
- **`npmMetadata` uses the PyPI-mapped shape** (`pypiMetadataForEvidence`):
  `repository` from `project_urls`, `maintainers` from `ownership.roles`, and
  `deprecated` from `yanked`. Give a benign fixture a repository and at least 2
  maintainers, so no governance signal fires.

Do **not** add a malicious PyPI fixture that hides its payload in a plain `.py`
module. The shared behavioral engine's obfuscation and exec-network detectors are
still shaped around JS primitives, so `exec(marshal.loads(...))` outside
`setup.py` is a documented v1 blind spot. Such a fixture would be a MISS, which
hard-fails. That parity work is tracked for a later release.

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
