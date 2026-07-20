# Compatibility & stability

As of **1.0.0**, the Stable surface below is a promise: it will not break
without a major version bump. This document states, plainly, what is covered by
that promise and what is explicitly still moving (the Experimental and opt-in
surfaces), so you know exactly what you can build on.

---

## Versioning policy

pkgxray follows [semantic versioning](https://semver.org/):

- **Major** (`1.0.0 → 2.0.0`) — any breaking change to a **Stable** surface
  below. These are rare and called out loudly.
- **Patch** (`1.0.0 → 1.0.1`) — bug fixes and detection-calibration changes.
  New *findings* on the same input are **not** a breaking change: the detection
  engine is expected to get more accurate over time, and a package that was
  `safe` yesterday may become `review`/`block` today (that is the entire point
  of [`recheck`](reference.md#monitoring-pkgxray-recheck)).
- **Minor** (`1.0.0 → 1.1.0`) — new surfaces, new flags, new JSON fields.
  Additive only on the stable surface (see below).
- The **JSON contract** carries its own `schemaVersion` (currently `1`),
  independent of the package version. Within a `schemaVersion`, fields are
  **added, never removed or repurposed**. A removal bumps `schemaVersion`.

---

## Surface tiers

### 🟢 Stable — safe to build on

Changes here are additive within a major version; removals wait for a major bump.

| Surface | Contract |
|---|---|
| `pkgxray guard <ref>` | decision (`allow`/`review`/`block`), exit codes `0`/`2`/`3`, quarantine-then-promote flow |
| `pkgxray audit <lockfile>` / `--file` | verdict, per-dep results, exit codes |
| `pkgxray recheck <lockfile>` | verdict-drift diff, `.pkgxray.lock` baseline format, exit codes |
| `--format json` output | `schemaVersion: 1`, additive fields only |
| `.pkgxray.json` config | the schema in [configuration.md](configuration.md); precedence order; "tighten freely, loosen loudly" invariants |
| MCP server tools | `audit_agent_extension_supply_chain`, `guard_agent_extension_install`, `audit_lockfile_supply_chain`, `triage_lockfile_supply_chain` — names and input shapes |
| Exit-code convention | `0` safe/allow · `2` block · `3` review, across every command |
| `pkgxray mcp` (connect-time MCP adapter) | subcommands + `--pin` / `--recheck` / `--package` / `--force` / `--no-package-scan` flags; the package-scan-first ordering |
| `pkgxray mcp-proxy` (per-call runtime gate) | the `pkgxray mcp-proxy -- <launcher>` invocation, `--policy strict\|balanced\|permissive`, `--pin` / `--recheck` / `--no-scan-results`; stdout stays protocol-clean |
| `pkgxray-cache` server + `PKGXRAY_CACHE_URL` | routes `GET /github/repos/{owner}/{repo}`, `GET /github/tarball/{owner}/{repo}/{ref}`, `GET /healthz`; opt-in via the env var; explicitly **not** an auth boundary |

### 🟡 Beta — works, contract may still shift

*None currently.* The former Beta surfaces (`mcp`, `mcp-proxy`, cache) graduated
to Stable in 0.16 with contract tests pinning their flags and routes.

### 🟠 Supported, opt-in — executes untrusted code

`pkgxray canary` is supported but sits apart from the rest of the tool: it is the
one surface that **runs** a package's install lifecycle. It is opt-in
(`--yes-run-untrusted-code`) and governed by a published
[threat model](canary-threat-model.md) — that document, not this table, is its
contract. It confirms malice behaviorally but **never clears** a package (a quiet
run is "not caught here," not "safe"), so its output shape may still gain fields
as hardening lands (TLS termination, loopback-only netns). Run it only on a
disposable host; pass `--require-sandbox` to fail closed without OS-level
isolation.

### 🔴 Experimental — may change or be removed without a major bump

| Surface | Note |
|---|---|
| `browser-extension/` | MV3 unpacked extension; not published to any store, load-unpacked only. |
| hookshot integration (`examples/hookshot/`) | depends on an external project's hook ABI. |

---

## Path to 1.0

1.0 means "the Stable surface above will not break without a major bump." The
checklist to get there:

- [x] **Calibration gate in CI** — the [benchmark corpus](../benchmark/) runs on
      every PR and fails on a false block or a missed detection, so the "0 false
      blocks" claim is enforced, not asserted. *(landed — keep the corpus growing)*
- [x] **Graduate or drop each Beta surface** — `mcp`, `mcp-proxy`, and the cache
      server are now **Stable**, with contract tests pinning their flags and
      routes. *(landed)*
- [x] **Freeze the JSON schema** — every `--format json` field is documented in
      one reference ([json-schema.md](json-schema.md)) committed to
      `schemaVersion: 1` (additive-only), with a schema-stability test that fails
      CI if a documented top-level field disappears. *(landed)*
- [x] **Freeze exit codes and the config schema** — the exit-code contract
      (`0` safe/allow · `2` block · `3` review, incl. `failOn` variants) is
      pinned by a stability test; the config schema is documented in
      [configuration.md](configuration.md). *(landed)*
- [x] **`canary` decision** — hardened (stronger `bwrap` namespace isolation,
      `--require-sandbox` fail-closed) and given a published
      [threat model](canary-threat-model.md); reclassified from Experimental to a
      supported, opt-in, executes-code surface. *(landed)*
- [x] **Publish + provenance** — the [`release` workflow](../.github/workflows/release.yml)
      gates every publish on the tests, the calibration benchmark, and pkgxray's
      own supply-chain `guard`, then ships with `npm publish --provenance` (SLSA
      attestation). *(landed — live on npm with a verified SLSA provenance
      attestation and registry signature.)*
- [x] **"0 heuristic false blocks on the top-1000 most-downloaded" proven at
      scale** — the [top-1000 validation harness](../validation/) gates on **0
      heuristic false blocks**. Revalidated 2026-07-19 against a list ranked by
      **real download counts** (not the earlier depended-upon snapshot): **0
      heuristic false blocks**, 3 correct known-CVE blocks. That fresh run first
      surfaced one FP — `registry-url` (`.npmrc`→registry-URL read) missing from
      the older list — which was narrowed and committed as a benign fixture.
      **Scope:** this claim is about the most-installed set only; a 2026-07-19 MCP
      scan found the heuristics over-block that newer ecosystem, tracked as
      calibration debt, **not** covered by this claim. *(landed — see
      [validation/README.md](../validation/README.md) and
      [docs/benchmark.md](benchmark.md#scope-of-the-claim-read-this-first))*
- [x] **Supported Node range** — the [test workflow](../.github/workflows/pkgxray-test.yml)
      runs `node --test` across `18 · 20 · 22 · 24 · 26`, proving the
      `engines.node` (`>=18`) floor, active LTS lines, and current Node.
      Node 18 is end-of-life upstream; production users should prefer a
      maintained release, but removing the published floor requires an explicit
      compatibility decision. *(landed)*

The 1.0 checklist is complete. Current priorities and experimental surfaces are
tracked in [project-status.md](project-status.md).
