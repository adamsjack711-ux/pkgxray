# MCP adapter — triage of `MCP_ADAPTER_PROMPT.md` against the actual code

Pattern follows `RECHECK_TRIAGE.md` / `INTEGRATION_TRIAGE.md`: each task's
assumptions reproduced against the current tree (main @ post-recheck merge),
marked **confirmed / partial / not-a-gap**, plan reduced to the honest net-new
delta.

## T1 — connect + read-only handshake + manifest enumeration

**Status: confirmed gap.** There is no MCP *client* anywhere in the repo.
`bin/mcp-server.js` is the inverse role (we answer JSON-RPC over stdio; we never
initiate). Its hardening is directly reusable as a discipline, inverted:

- stdin buffer cap (`bin/mcp-server.js:17-27`) → our client must cap the child's
  stdout/stderr the same way (a chatty/hostile server must not OOM us);
- `sanitizeErrorMessage` (`bin/mcp-server.js:271`) → strip local paths from
  errors we print/return.

`guardExtension(reference, options)` (`src/quarantine.js:74`) is the
package-scan-first call, exactly as `pkgxray guard` uses it; returns
`{ reference, decision, report, ... }` with `decision ∈ {allow, review, block}`
folded from `report.verdict`. Confirmed usable unchanged.

CLI dispatch: `bin/audit.js` `parseArgs` keys subcommands positionally
(`guard`/`audit`/`recheck`/`triage`); an `mcp` key slots in the same way.
Exit codes `2 block / 3 review / 0 safe` confirmed at every existing surface.

Net-new delta: one transport module (stdio spawn + streamable HTTP), the
lifecycle handshake (`initialize` → `notifications/initialized` → `tools/list`,
with pagination via `nextCursor`), manifest normalization, spawn hygiene.
Node core only — no SDK.

## T2 — route the manifest through the existing scanner

**Status: confirmed, with one wrinkle the prompt did not anticipate.**

Confirmed as speced:

- `auditEvidence(input)` (`src/auditor.js:386`) accepts `sourceFiles` as a
  `path → text` map (`normalizeSourceFiles`, `src/auditor.js:362`). The manifest
  shapes into that directly.
- Doc-typed paths (`.md`/`.txt` — `DOCUMENTATION_EXTENSIONS`,
  `src/auditor.js:304`) get **exactly** the right scan set (`auditFiles`,
  `src/auditor.js:926-929`): `inspectInjectionAttempt` +
  `inspectConcealedInjection` (tiered injection matcher, unicode-tag smuggling,
  base64-envelope decode) and **skip the code-malware heuristics** — so a tool
  description that legitimately mentions `process.env` or `curl` does not
  false-positive as exfil. This is precisely the engine subset a manifest needs.
  ⇒ each tool is rendered as `mcp-manifest/tools/<name>.md` (name + description
  + pretty-printed inputSchema), server info as `mcp-manifest/server.md`.
  Paths deliberately avoid `TEST_DIR_REGEX` components (no `examples/`,
  `fixtures/`…) so nothing is downgraded as fixture text.

The wrinkle — **manifest-only evidence can never reach `safe` unmodified**:
`auditMetadata` pushes `missing-package-json` when no package.json is present
(`src/auditor.js:489`), and `decideVerdict` (`src/auditor.js:1995`) forces
`review` on `missing-evidence` / `missing-package-json` / `package-metadata`.
Those categories describe *package* evidence completeness; a manifest is a
different input type for which "no package.json" is not missing evidence.
Resolution (adapter plumbing, not a matcher fork): the mcp module calls
`auditEvidence`, then drops findings whose category is in the
package-evidence-completeness set (`missing-evidence`, `missing-package-json`,
`package-metadata`, `missing-metadata`, `supply-chain-signal`, `github-fetch`)
before folding the verdict, reusing `worstVerdict`/`verdictRank` exported by
`src/recheck.js:394`. The verdict vocabulary stays `{safe, review, block}` —
same dialect, no fork. When the server *also* went through the package scan
(the normal path), the package verdict is reported alongside and folds in.

## T3 — capability-surface mismatch

**Status: confirmed gap (the one net-new detector).** Nothing in
`src/auditor.js` looks at JSON-Schema parameter shapes. Calibration rules
inherited from the base engine: mismatch = narrow declared purpose × exec-shaped
parameter; powerful-but-coherent tools (`path` on a file reader, `url` on an
HTTP tool, `query` on a DB tool) stay `safe`; ambiguity routes to `review`,
never `block` on the mismatch alone. Findings carry the offending param + the
description as citable evidence, like every other finding.

## T4 — pin approved manifests + drift/rug-pull recheck

**Status: partial — store fits, but needs one additive field.**

- Store: `src/triage.js` `loadDecisions`/`saveDecisions`/`normalizeRecord`,
  `SCHEMA_VERSION = 1`, records keyed `name@version`. Confirmed reusable — an
  MCP server pins as `name` = server name (from `initialize`), `version` =
  server version.
- `verdict`/`checkedAt` baseline + `isStale(record, ttlMs?)`
  (`src/triage.js:65`) confirmed reusable unchanged.
- **Gap:** `normalizeRecord` (`src/triage.js:44`) strips unknown fields and
  `saveDecisions` (`src/triage.js:104`) serializes a fixed set — a manifest
  fingerprint would be silently dropped today. Additive fix in the T1–T4 spirit
  of the recheck tier: optional `manifest` field (per-tool
  `{name, descriptionSha256, schemaSha256}` fingerprints) tolerated absent,
  never back-filled, no schema bump. Legacy readers ignore it; legacy records
  stay valid.
- Drift classification: `classifyDrift`/`worstVerdict` (`src/recheck.js`)
  reused for the regression-vs-known-state rule; manifest drift (changed
  description / new tool / widened schema) is its own surface on top, since
  package recheck has no per-content fingerprint to diff.

## Surface

- CLI `pkgxray mcp` — confirmed slot in `bin/audit.js` (see T1). Flags:
  `--http <url>` vs positional stdio command, `--package <ref>` (what to
  package-scan first when the spawn command doesn't name it), `--no-package-scan`
  (loud caveat note), `--force` (connect past a `block` package scan), `--pin`,
  `--format json|markdown`.
- MCP tool in `bin/mcp-server.js` — optional per the prompt; **deferred** to a
  follow-on so the connect-time layer lands first (the local-reference guard
  reasoning there is non-trivial: "audit this server" must not become a
  remote-spawn primitive).

## Out of scope (unchanged from the prompt)

Runtime `tools/call` gating, tool-*result* injection, cross-server
confused-deputy. This layer only ever lists.
