# JSON output schema (`--format json`)

Every pkgxray command accepts `--format json` and emits a single JSON object on
stdout (diagnostics go to stderr, so stdout stays parse-clean). This is the
machine contract external tools build on, so it is versioned independently of
the package version.

## Versioning

- Every payload carries **`schemaVersion` (currently `1`)**.
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
| `verdict` (analysis) | `safe` · `review` · `block` |
| `decision` (install/promotion) | `allow` · `review` · `block` |
| finding `severity` | `info` · `low` · `medium` · `high` |
| exit code (all commands) | `0` safe/allow · `2` block · `3` review |

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
  "schemaVersion": 1,
  "verdict": "block",            // safe | review | block
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
  "schemaVersion": 1,
  "decision": "block",           // allow | review | block
  "reference": "npm:left-pad@1.3.0",
  "resolved": { /* resolved ref: type, name, version, … */ },
  "sourceFiles": { /* path -> content that was scanned */ },
  "githubMetadata": { /* repo signals, or null */ },
  "npmVsGithubDiff": { /* divergence result, or null */ },
  "provenanceAttestation": { /* sigstore/SLSA result, or null */ },
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
  "report": { /* the full audit payload above */ }
}
```

## `audit <lockfile>` — `audit_lockfile_supply_chain`

Batch OSV scan of a lockfile (`package-lock.json`, `yarn.lock`,
`pnpm-lock.yaml`, `package.json`).

```jsonc
{
  "schemaVersion": 1,
  "file": "package-lock.json",
  "format": "npm",
  "totalDeps": 128,
  "uniqueDeps": 128,
  "timings": { "osvMs": 0, "deepMs": 0, "totalMs": 0 },
  "summary": { "safe": 126, "reviewed": 1, "blocked": 1 },
  "worstDecision": "block",      // safe | review | block
  "results": [
    {
      "name": "left-pad",
      "version": "1.3.0",
      "paths": ["node_modules/left-pad"],   // up to 3
      "decision": "safe",                    // safe | review | block
      "vulnerabilities": [ { "id": "GHSA-…", "aliases": ["CVE-…"] } ],
      "deep": null,                          // full guard report when --deep
      "triaged": false,                      // decided via .pkgxray.lock
      "unresolved": true,                    // present only for non-OSV-queryable deps
      "unresolvedKind": "workspace"          // …with the reason
    }
  ]
}
```

## `recheck <lockfile>`

A **diff** against the stored `.pkgxray.lock` baseline, not a full report.

```jsonc
{
  "schemaVersion": 1,
  "file": "package-lock.json",
  "format": "npm",
  "totalDeps": 128,
  "updated": 3,
  "counts": { /* per-bucket sizes */ },
  "worstRegression": "review",   // safe | review | block
  "exitCode": 3,
  "buckets": {
    "regressed":  [ /* depDrift */ ],
    "improved":   [ /* depDrift */ ],
    "unchanged":  [ /* depDrift */ ],
    "noBaseline": [ /* depDrift */ ],
    "unknown":    [ /* depDrift */ ]
  },
  "versionDrift": {
    "updateAvailableSafe":    [ /* newer version guards clean */ ],
    "updateAvailableFlagged": [ /* newer version is review/block */ ],
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
  "verdict": "review",    // fresh verdict
  "drift": "regressed",   // regressed | improved | unchanged | no-baseline | unknown
  "checkedAt": "2026-07-08T…",
  "decision": "review",
  "error": "…"            // present only when the recheck itself errored
}
```

---

> **Experimental:** `pkgxray canary` emits `{ "static": <audit report>,
> "behavioral": <…> }`. It is an [Experimental surface](compatibility.md#-experimental--may-change-or-be-removed-without-a-major-bump)
> and its `behavioral` shape is not yet frozen.
