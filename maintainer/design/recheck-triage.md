# RECHECK_TRIAGE — monitoring tier (verdict-drift + version-drift)

Triage for the `pkgxray recheck` capability. Confirms what the engine already
has vs. what each task must add, so `recheck` is an orchestration layer, not a
fork of guard logic.

## Verdict vocabulary (as-built, do not invent a second dialect)

Two spaces already coexist and mean different things — recheck must respect both:

- **verdict** — the *computed* result of a guard evaluation. `report.verdict ∈
  {"safe", "review", "block"}` (`auditEvidence` / `guardExtension`). The
  per-dep lockfile audit surfaces the same three as `result.decision` (note:
  it uses the literal `"safe"`, not `"allow"`).
- **decision** — the *human* triage choice persisted in `.pkgxray.lock`:
  `{"allow", "block"}` only. `decisionForReport()` maps `verdict "safe" → "allow"`,
  `"review" → "review"|"allow"` (policy), `"block" → "block"`.

Ranking (worst-fold), already inline in `lockfile.js:301`:
`block > review > safe`. There is **no named** worst-fold helper yet — the fold
is the ternary `blocked>0?block:reviewed>0?review:safe`. T2 extracts a tiny
shared helper rather than reimplementing the ternary in three places.

## What exists

| Capability | Where | Notes |
|---|---|---|
| `.pkgxray.lock` load/save | `src/triage.js` (`loadDecisions`, `loadDecisionsSync`, `saveDecisions`) | Record = `{name, version, decision, reason, decided_at}`. `schemaVersion: 1`. |
| Per-dep guard evaluation | `src/quarantine.js` `guardExtension(ref, opts)` → `{report:{verdict,grade,riskBands,...}, decision}` | This IS "re-run the guard evaluation against current intelligence" (OSV + provenance + divergence + static). |
| Lockfile walk + pinned versions | `src/lockfile.js` `parseLockfile` → `Map<name@version,{name,version,paths}>`; `auditLockfile` | `deps` exposes the pinned `version` per dep. ✅ |
| Batch OSV | `src/lockfile.js` `batchOsvQuery` | querybatch, 1000/chunk, keep-alive agent. |
| Bounded-concurrency worker pool | `src/lockfile.js` `runDeep` (inline queue + `Math.min(DEEP_CONCURRENCY=4, n)` workers) | Only pool that exists. T2 extracts it to `src/pool.js` (`mapPool`) and both callers share it — reuse, not reimplementation. Cap raised to `min(8, cpus, n)` per the recheck spec. |
| `PKGXRAY_CACHE_URL` plumbing | `src/cache-client.js` (`getCacheUrl`/`isEnabled`), consumed by `github.js` | Inert unless env set; flows automatically through `guardExtension`. recheck just must **not disable** it. |
| npm packument fetch | `src/quarantine.js` `fetchNpmMetadata(spec, registry)` | Fetches `/<name>/<version|latest>` — a single version, NOT the version list. T3 adds a packument (`/<name>`) fetch for `.versions` + `.dist-tags.latest`. |
| CLI dispatch | `bin/audit.js` `parseArgs` (guard/audit/triage), exit `2 block / 3 review / 0 safe` | T2/T4 add a `recheck` subcommand keyed the same way. |

## Answers to the triage questions

- **Does `.pkgxray.lock` store a timestamp per record?** Yes — `decided_at` (when
  the *human* decided). It does **not** store when the *verdict* was computed, nor
  the computed verdict itself. Verdict-drift needs a `checkedAt` baseline + a stored
  `verdict`. → **T1**.
- **Does `lockfile.js` expose the pinned version per dep?** Yes — `parseLockfile`
  returns `version` per entry. ✅ no work needed.
- **Does anything query the registry for the version list?** No. `fetchNpmMetadata`
  fetches one version's manifest. T3 adds `listNpmVersions(name)` over the packument.

## Per-task delta

- **T1 — `checkedAt` foundation.** Add `checkedAt` (ISO) + `verdict`
  (`safe|review|block`) to the record. `loadDecisions*` read them as optional;
  **missing `checkedAt` must NOT be fabricated** (unlike `decided_at`, which is
  back-filled) — missing = unknown/stale. triage write paths populate both
  (`verdict: r.decision`, `checkedAt: now`). Add `isStale(record, ttlMs?)`
  (no `checkedAt` ⇒ always stale; with `ttlMs` ⇒ stale if age exceeds it) — reused
  by T2 and the proxy TTL PR. `schemaVersion` stays `1` (fields are additive;
  tests assert `=== 1`).
- **T2 — verdict-drift recheck.** `src/recheck.js`: walk lockfile, re-`guardExtension`
  each pinned dep via `mapPool`, compare new verdict to stored `verdict`, bucket
  regressed/improved/unchanged, worst-fold exit code, write back
  `verdict`/`checkedAt`. Errored dep ⇒ `unknown`, never overwrites a good stored
  verdict.
- **T4 — CI-cron surface.** `--format json`, exit code = worst **regression** (not
  worst absolute verdict — a still-block dep that was already block is not a new
  regression), README scheduled-workflow snippet.
- **T3 — version-drift.** `listNpmVersions` + guard the latest (and latest-in-range
  if different); bucket update-available-safe/flagged; informational (out of exit
  code) unless `--fail-on-available-updates`.

## Out of scope (noted, not built)

Auto-upgrade / auto-PR of bumps; post-install runtime-fetch payloads (the engine's
stated blind spot — recheck re-evaluates bytes + intelligence, not runtime).
