# JSON output schema (`--format json`)

This is the **unpublished breaking 2.0 candidate** contract. The 1.3 work
remains a separate held PR; this document does not announce publication.

Commands with `--format json` emit a single JSON object on
stdout (diagnostics go to stderr, so stdout stays parse-clean). This is the
machine contract external tools build on, so it is versioned independently of
the package version.

## Versioning

- Public decision payloads carry **`schemaVersion: 2`**. Internal raw analyzer
  reports and configuration, baseline and receipt persistence formats retain
  their own schema versions; the public version is not a migration instruction
  for stored files. Artifact approval receipts independently use version `2`.
- Within a `schemaVersion`, fields are **added, never removed or repurposed** — a
  consumer that reads today's fields keeps working. A removal or a semantic
  change to an existing field bumps `schemaVersion`.
- `schemaVersion` is **not** the package version. pkgxray `0.x → 1.0` does not
  imply `schemaVersion 1 → 2`.

New/unknown fields may appear at any level — parse defensively (ignore what you
don't recognize) rather than failing on unexpected keys.

## Shared enums

| Value space | Values |
|---|---|
| public `verdict` (analysis) | `safe` · `block` |
| `decision` (install/promotion) | `allow` · `block` |
| finding `severity` | `info` · `low` · `medium` · `high` |
| public decision exit code | `0` safe/allow · `2` block |
| gate `outcome` | `SAFE` · `UNSAFE` |

Uncertainty remains evidence: findings keep their severity and rationale, and
raw analyzer internals may still use `review`. At the public boundary it blocks,
with `resolution.reasonCodes` explaining why. Public `rawVerdict` uses
`inconclusive` for raw uncertainty. `UNSAFE` means use was not cleared; it does
not by itself claim confirmed malware. Operational/usage errors and Compose
flow-only `analysisStatus` are separate from safety decision exits.

## Shared objects

### `finding`

```jsonc
{
  "severity": "high",              // info | low | medium | high
  "category": "credential-access", // stable slug (see docs/reference.md severity policy)
  "file": "collect.js",            // source path, or a synthetic label (e.g. NPM_VS_GITHUB)
  "snippet": "readFileSync(...)",  // short, clipped evidence excerpt
  "rationale": "…"                 // human-readable why-this-matters
}
```

### `riskBand`

```jsonc
{
  "band": "github-lonely",
  "label": "github-lonely",
  "severity": "low",
  "count": 1,
  "examples": ["GITHUB_METADATA"],
  "rationale": "…"
}
```

### `parameters` (audit / guard report)

A fixed set of scored dimensions, each `0..1`:
`installHooks`, `codeExecution`, `dataAccess`, `networkExposure`, `persistence`,
`obfuscation`, `knownVulnerabilities`, `provenance`, `injectionResistance`,
`evidenceCompleteness`.

### `configEffects`

What `.pkgxray.json` changed for this run (the "loosen loudly" audit trail):

```jsonc
{
  "muted": [],           // findings suppressed by a mute rule
  "mutedCount": 0,
  "allowlisted": null,   // the matching allow entry, if any
  "ignoredAllow": null,  // an allow that was dropped (unpinned / digest mismatch)
  "notices": []          // human-readable notes about applied loosenings
}
```

---

## `audit` (evidence) — `--file`, stdin, `audit_agent_extension_supply_chain`

The static verdict over supplied evidence.

```jsonc
{
  "schemaVersion": 2,
  "verdict": "block",            // safe | block
  "grade": "F",                  // letter grade
  "score": 0.0,                  // 0..1
  "parameters": { /* the 10 scored dimensions above */ },
  "summary": "…",
  "packageName": "example",      // or null
  "riskBands": [ /* riskBand */ ],
  "findings": [ /* finding, sorted worst-first */ ],
  "configEffects": { /* configEffects */ }
}
```

## `guard` — `guard_agent_extension_install`

Stage → vuln-check → audit a real package. Nests the full `audit` payload under
`report`.

```jsonc
{
  "schemaVersion": 2,
  "decision": "block",           // allow | block
  "reference": "npm:left-pad@1.3.0",
  "resolved": { /* resolved ref: type, name, version, … */ },
  "sourceFiles": { /* path -> content that was scanned */ },
  "githubMetadata": { /* repo signals, or null */ },
  "npmVsGithubDiff": { /* divergence result, or null */ },
  "provenanceAttestation": {
    "attested": true,           // a SLSA-shaped claim exists, not proof of authenticity
    "verification": {
      "status": "verified",    // verified | unverified | absent | invalid
      "required": false,
      "artifactBound": true,   // only true after signature + exact artifact checks
      "cryptographicallyVerified": true,
      "verifier": "sigstore@5.0.0"
    }
  },
  "vulnerabilityPrecheck": {
    "enabled": true,
    "database": "OSV",
    "vulnerabilityCount": 0,
    "vulnerabilities": [ /* OSV entries */ ]
  },
  "timings": { /* per-phase ms */ },
  "quarantinePath": "/…",        // private staging dir
  "stagedPath": "/…",
  "promotedPath": null,          // set when policy promoted the package
  "allowed": false,
  "outcome": "UNSAFE",
  "assessment": { "checks": { "source": "completed", "vulnerabilities": "failed" } },
  "resolution": {
    "reasonCodes": ["vulnerability-check-unavailable"],
    "retry": { "attempted": true, "attempts": 1, "check": "vulnerabilities" }
  },
  "report": { /* the full audit payload above */ }
}
```

`review`, `reviewPlan`, review IDs and choices are absent from public output.
CLI/MCP review inputs and session Proceed/Decline decisions are removed. MCP
guard is read-only: it redacts source contents and staging paths and rejects
promotion arguments; local CLI/library promotion has a separate boundary.
A zero vulnerability count is not evidence of success: check completion status
and `resolution` before treating an empty list as a completed query.

### `resolution` and actual retry telemetry

`resolution.reasonCodes` records machine-readable causes such as
`uncertain-findings`, `incomplete-checks`, `source-check-disabled`,
`vulnerability-check-unavailable`, `incomplete-dependency-scan` or
`unresolved-package-identity`. Codes can be added; preserve unknown codes and
display the associated evidence. An optional `explanation` describes a refusal
without converting missing evidence into a malware claim. An empty guard reason
list indicates no blocking reasons were found under the checked policy.

`resolution.retry` records work actually attempted, not a proposed review plan.
For guard, `attempts` counts **additional** vulnerability-check attempts: `0` or
`1`, with `attempted` a boolean and `check` null when unused or
`"vulnerabilities"` when retried. One eligible transient OSV failure may retry
against the same resolved identity, within the original shared 15-second
deadline. It does not reacquire package bytes. Disabled checks, malformed
evidence, permission gaps, heuristic uncertainty and finding-bearing reports
do not trigger this retry. Persistent failure blocks. This telemetry is not a
count of all network activity or acquisition attempts.

Lockfile batch `resolution.retry` also uses `check: "vulnerabilities"`, but
`attempts` is aggregated across OSV chunks (up to 1,000 package queries each).
Each chunk may retry once within its own original shared 15-second deadline;
the batch counter can exceed one. Per-result retry objects may refer to that
shared batch telemetry and must not be summed as independent retry counts.

The supplied-evidence MCP worker path has its own narrow transient-failure
retry against the same captured snapshot and original deadline. Do not infer
that guard's vulnerability telemetry records worker retries, or that every
missing check is retryable. See [the automatic contract](review-contract.md).

## `audit <lockfile>` — `audit_lockfile_supply_chain`

Batch OSV scan of a lockfile (`package-lock.json`, `yarn.lock`,
`pnpm-lock.yaml`, `package.json`).

```jsonc
{
  "schemaVersion": 2,
  "file": "package-lock.json",
  "format": "npm",
  "totalDeps": 128,
  "uniqueDeps": 128,
  "timings": { "osvMs": 0, "deepMs": 0, "totalMs": 0 },
  "summary": { "safe": 126, "blocked": 2, "inconclusive": 1 },
  "resolution": { "retry": { "attempted": false, "attempts": 0, "check": "vulnerabilities" } },
  "worstDecision": "block",      // safe | block
  "results": [
    {
      "name": "workspace-example",
      "version": "workspace:*",
      "paths": ["node_modules/workspace-example"],   // up to 3
      "decision": "block",                   // safe | block
      "vulnerabilities": [],
      "resolution": { "reasonCodes": ["unresolved-package-identity"] },
      "deep": null,                          // full guard report when --deep
      "triaged": false,                      // decided via .pkgxray.lock
      "unresolved": true,                    // present only for non-OSV-queryable deps
      "unresolvedKind": "workspace"          // …with the reason
    }
  ]
}
```

`summary.safe` and `summary.blocked` partition the result decisions.
`summary.inconclusive` counts blocked results with uncertainty or incomplete
check reasons; it is a subset of `blocked`, not a third decision bucket.

## `recheck <lockfile>`

A **diff** against the stored `.pkgxray.lock` baseline, not a full report.

```jsonc
{
  "schemaVersion": 2,
  "file": "package-lock.json",
  "format": "npm",
  "totalDeps": 128,
  "updated": 3,
  "counts": { /* per-bucket sizes */ },
  "worstRegression": "block",   // safe | block
  "exitCode": 2,
  "buckets": {
    "regressed":  [ /* depDrift */ ],
    "improved":   [ /* depDrift */ ],
    "unchanged":  [ /* depDrift */ ],
    "noBaseline": [ /* depDrift */ ],
    "unknown":    [ /* depDrift */ ]
  },
  "versionDrift": {
    "updateAvailableSafe":    [ /* newer version guards clean */ ],
    "updateAvailableFlagged": [ /* newer version is blocked or inconclusive */ ],
    "unknown":                [ /* couldn't be vetted */ ]
  }
}
```

`depDrift` (each bucket entry):

```jsonc
{
  "name": "left-pad",
  "version": "1.3.0",
  "baseline": "safe",     // stored verdict
  "verdict": "block",     // fresh public verdict
  "drift": "regressed",   // regressed | improved | unchanged | no-baseline | unknown
  "checkedAt": "2026-07-08T…",
  "decision": "block",
  "error": "…"            // present only when the recheck itself errored
}
```

---

> **Experimental:** `pkgxray canary` emits `{ "static": <audit report>,
> "behavioral": <…> }`. It is an [Experimental surface](compatibility.md#-experimental--may-change-or-be-removed-without-a-major-bump)
> and its `behavioral` shape is not yet frozen.

### Source collection coverage

Guard results include `sourceCoverage`: `complete`, `scannedFiles`, `skippedFiles`,
`truncatedFiles`, `reasons`, and `behavioralScope` (`npm-static-heuristics` or
`python-manifests-and-text`). `complete` concerns supported source-file collection,
not proof that all behavior is understood. Incomplete collection adds an
`incomplete-source-scan` finding and blocks use or promotion.

Lockfile results include `coverage.sourceScan` (`none`, `blocked-only`, or
`all-resolved`), `coverage.vulnerabilityCheck`, and `coverage.deepFailures`.
A requested deep scan that errors blocks and retains the incomplete-check reason.

### Guard assessment record

`assessment.engine` identifies the engine name/version. `assessment.artifact`
contains the resolved name, version, origin and tarball SHA-256 when available;
a null digest (for example a local directory) does not claim content binding.
`effectivePolicy` and `policySha256` describe the effective guard policy.
`rawVerdict` precedes policy overrides; `decision` is the final promotion decision.

`assessment.checks` reports source, vulnerability and direct-dependency checks
as `completed`, `partial`, `failed`, `disabled`, `skipped`, or `not-requested`, as
applicable. A version and policy fingerprint are audit metadata, not a signed
attestation or a guarantee that later-installed bytes are identical.

`sourceCoverage.runtimeFiles` and `installTimeFiles` record known literal
reachability. `inventoryFiles` counts inventoried regular files. Coverage is
limited to supported static resolution; it does not prove all possible execution
paths are understood.


Archive-backed guard results also include `approval`: a version-2 local record of `artifactSha256`, manifest `name`/`version`, `scannerBuildId`, `policySha256`, `checks`, `sourceComplete`, `authorization`, `decision` and `issuedAt`. `authorization` contains `mandatoryHoldReasons`, `behavioralCoverage` (`completed` or `partial`) and `explicitOverride` (a hash-pinned operator allow). The same authorization appears in `assessment`. This record may describe BLOCK or incomplete scans; its presence alone is not permission to install. Consumers reject version-1 receipts and verify identity, digest, build, policy, decision and completed source/vulnerability checks. Mandatory holds cannot be cleared by manual decisions or explicit operator overrides. Legacy review receipts never authorize use. Local-directory scans have no compressed-artifact digest and do not mint this record. Receipts are local trust records, not cryptographic signatures.

`assessment.engine.buildId` deterministically hashes package metadata and every regular file under `src/` and `bin/`, including the vendored parser and data. `assessment.artifact.resolved` and `.integrity` record acquisition identity where available. Npm lockfile results retain `artifacts` (unique URL/SRI pairs); deep results expose `artifactVerified` and `approval`, or an error when exact identity cannot be established. Lockfile `coverage.vulnerabilities` distinguishes enabled/completed checks and their evidence origin (`OSV`, `caller-supplied`, or `none`); internal supplied-result hooks are not exposed over MCP.
