# pkgxray calibration benchmark

For the broader challenge and its **unresolved misses and false reviews**, see [adversarial results](adversarial/README.md). Calibration performance below describes these 70 fixtures, not real-world detection accuracy.

A committed corpus of **labelled fixtures** run through the real static engine
(`auditEvidence` — no network, no execution) to make pkgxray's calibration
fixture results reproducible and regression-gated. It does not rerun the
historical top-1000 registry validation or establish registry-wide accuracy.

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
| `UNDER_FLAG` | expected `review` becomes `safe`, or a documented `knownUnderflag` becomes `review` instead of `block` | warn |
| `RECALL_DROP` | another expected `block` case reaches `review` | **hard fail** |
| `COVERAGE_DROP` | a cohort loses previously retained malicious, benign, or blocking evidence | **hard fail** |
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

The gate rejects false blocks and full misses, subject to the explicit
known-false-positive exemptions above, and enforces a full-corpus block recall
floor; new block-to-review regressions also fail. Exemptions affect the gate,
**not the metrics**: block **precision** is
malicious blocked / all blocked, including known false positives; **recall** is
malicious blocked / all malicious. A zero denominator is `null` in JSON and
`N/A` in human output. REVIEW counts and rates expose the workload that a
false-block metric alone misses. These rates describe the labelled fixture
corpus, not the prevalence or accuracy of detection across a registry.

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

A fixture marked `knownUnderflag` documents a policy decision to send a known
malicious shape to human review rather than block. These cases remain visible
as `UNDER_FLAG` warnings. New block-to-review regressions fail the gate, and
the full corpus must still meet its committed block-recall floor. See the
[severity policy](../docs/reference.md#severity-policy-what-lands-in-block--review--info).

### Cohorts (npm, PyPI, and MCP)

Every fixture belongs to a **cohort**, meaning its ecosystem, set by an optional
`"cohort"` field that defaults to `"npm"`. Running `npm run benchmark` with no
flags is what CI gates on, and it includes **all** cohorts, so the floor and
false-block gates cover all cohorts together. The report also breaks out each
cohort with its own denominators. `--cohort pypi` runs only the PyPI
fixtures for a focused read. A cohort filter skips the recall floor, because the
committed floor is defined over the full corpus. The
[2026-10-04 fixture baseline](baselines/2026-10-04.json) records the combined
and per-cohort metrics with engine/corpus hashes. It is an offline fixture
baseline, not a fresh live-registry validation.

The runner also enforces **retention minimums per cohort**, including when a
cohort is filtered. The default run checks every retained cohort even if all its
files disappear. These counts preserve the evidence present in the recorded
baseline; they are **not sufficient-coverage targets or accuracy guarantees**:

| Cohort | Malicious fixtures retained | Benign fixtures retained | Malicious BLOCK results retained |
|---|---:|---:|---:|
| npm | 25 | 32 | 24 |
| PyPI | 5 | 7 | 5 |
| MCP | 0 | 1 | 0 |

Definitions live in `COHORT_MINIMUMS` in [`run.js`](run.js). Raise them
deliberately as independently reviewed evidence is added. Do not lower a floor
or remove a fixture to make CI pass. Additional fixtures are allowed. A filtered
run checks only its selected cohort; a missing or unknown cohort argument fails.
The MCP zero explicitly preserves an unresolved gap, not a successful recall
measurement. Existing JSON schema version 2 now includes `coverage.cohorts`,
`coverage.warnings`, and `coverage.retentionGatePassed`; retention failures also
appear in `hardFailures`. Human reports print coverage limits even when the gate
passes.

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

PyPI coverage is limited to install manifests, vulnerability checks, metadata,
and shared text checks. The JavaScript behavioral suite is skipped on ordinary
PyPI source files; general Python behavioral parity remains unimplemented.
Current PyPI fixtures therefore do not measure general Python malware detection.
Keep this coverage gap explicit instead of treating a passing cohort as parity
with npm. Likewise, a cohort without malicious fixtures has unmeasured recall;
one benign MCP fixture cannot establish MCP detection accuracy.

## Adding a case

1. Drop a JSON file in `corpus/malicious/` or `corpus/benign/`.
2. Set `expect` to the verdict a reviewer would assign the *sample* (not
   necessarily what the engine does today — an honest label lets an under-flag
   show up as a warning).
3. Run `npm run benchmark`. A false block, full miss, or undocumented
   block-to-review regression fails. Document a deliberate review policy with
   `knownUnderflag` and a rationale; do not relabel a malicious sample benign.

Real-world tarballs are the best source of new fixtures — reduce a known-malicious
package to the smallest source that still trips the finding, and add a benign
counterpart that looks similar but shouldn't gate.
