# Evasion triage — behavioral HIGH rules defeated by string-splitting / hidden sinks

Reproduced from a clean checkout (commit `3ae7613`) with:

```
node ./bin/audit.js --file test/fixtures/evasion/<case>.json
```

Source-scan calibration (the 47 most-installed packages) was run with OSV +
GitHub cross-checks disabled (`--no-vulnerability-check --no-github`) because
those endpoints are unreachable from the build sandbox; the behavioral rules
being changed here live entirely in the source scan, so this isolates exactly
the surface under test. Baseline: **0 blocks**.

| case | current verdict | expected verdict | root cause | confirmed? |
|------|-----------------|------------------|------------|------------|
| F1 `f1-ssh-exfil` | `safe` (A+ 98) | `block` | `SUSPICIOUS_READ_TARGETS` / `NETWORK_REGEX` match literal substrings only. The `.ssh/id_rsa` path is assembled from an array of fragments (`[".s","sh","id_r","sa"]`) and `https` from `"ht"+"tps"`, so no literal matches → no behavioral finding. | ✅ yes |
| F2 `f2-dynamic-require` | `review` (C+ 79) | `block` | Network primitive is `lib.request(...)` where `lib = require(<variable>)`, so `NETWORK_REGEX` misses it and the env+network HIGH in `inspectExecNetworkCombinations()` never fires. Only the lone `webhook.site` MEDIUM + bulk-env MEDIUM keep it at review. | ✅ yes |
| F3 `f3-sendbeacon` | `review` (C+ 79) | `block` | `navigator.sendBeacon` is not in `NETWORK_REGEX`, so the bulk-env + network HIGH doesn't trigger. Only the bulk-env MEDIUM keeps it at review; with a non-flagged domain it would be `safe`. | ✅ yes |
| F4 `f4-bulk-env` | `safe` (spread shape) | `review` | Bulk-env harvest on its own is *partly* handled: `JSON.stringify(process.env)` / `Object.entries(process.env)` already emit a MEDIUM (`environment-access`) → review. But the **spread / clone shapes** `{...process.env}` and `Object.assign({}, process.env)` are missing from `BULK_ENV_REGEXES`, so a whole-env dump via spread is `safe`. | ✅ partial gap (spread only) |

## Notes

- **F4 is only a partial gap.** The core "bulk env harvest alone → review" ask in
  the prompt is *already satisfied* for the `JSON.stringify` / `Object.entries`
  shapes (they emit MEDIUM `environment-access`). The genuine, reproducible gap is
  the **object-spread / `Object.assign` clone** of `process.env`, which the
  existing `BULK_ENV_REGEXES` don't cover. PR #3 closes that specific shape; it
  does not re-introduce a "bulk env on its own" rule that already exists.

- All four fixtures live under `test/fixtures/evasion/`.

## Fix → PR mapping (smallest/safest first)

1. **PR #1 / commit — F3:** extend `NETWORK_REGEX` with additional exfil sinks
   (`navigator.sendBeacon`, `EventSource`, `dgram.createSocket`, `dns.*`, remote
   `import()`, `new Image()`+`.src` beacon).
2. **PR #2 / commit — F2:** add a `dynamic-require` signal (review on its own,
   HIGH when paired with bulk-env harvest in the same file).
3. **PR #3 / commit — F4:** add the object-spread / `Object.assign` clone shapes
   to `BULK_ENV_REGEXES`.
4. **PR #4 / commit — F1:** add a conservative deobfuscation/normalization pass
   (fold adjacent literal `+` concat, resolve simple string-array element access)
   and run the credential / network / domain checks against the normalized text
   as well as the original.

Per the chosen workflow, all four land as separate commits on
`claude/pkgxray-detection-hardening-xozbbl` with a single PR.
