# Compatibility & stability

pkgxray is pre-1.0. This document states, plainly, **what is a promise and what
is still moving** — so you can depend on the stable surface today and know which
edges may shift before 1.0.

---

## Versioning policy

pkgxray follows [semantic versioning](https://semver.org/). While the major
version is `0`:

- **Patch** (`0.16.0 → 0.16.1`) — bug fixes and detection-calibration changes.
  New *findings* on the same input are **not** a breaking change: the detection
  engine is expected to get more accurate over time, and a package that was
  `safe` yesterday may become `review`/`block` today (that is the entire point
  of [`recheck`](../README.md#monitoring-pkgxray-recheck)).
- **Minor** (`0.16.0 → 0.17.0`) — new surfaces, new flags, new JSON fields.
  Additive only on the stable surface (see below).
- The **JSON contract** carries its own `schemaVersion` (currently `1`),
  independent of the package version. Within a `schemaVersion`, fields are
  **added, never removed or repurposed**. A removal bumps `schemaVersion`.

At 1.0 this tightens: any breaking change to a **Stable** surface requires a
major bump, and each surface below graduates or is explicitly dropped.

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
| `.pkgxray.json` config | the schema in [config.md](config.md); precedence order; "tighten freely, loosen loudly" invariants |
| MCP server tools | `audit_agent_extension_supply_chain`, `guard_agent_extension_install`, `audit_lockfile_supply_chain`, `triage_lockfile_supply_chain` — names and input shapes |
| Exit-code convention | `0` safe/allow · `2` block · `3` review, across every command |

### 🟡 Beta — works, contract may still shift

Shipped and tested, but flag names, output shape, or defaults may change in a
minor release before they graduate to Stable.

| Surface | Since | Why it's beta |
|---|---|---|
| `pkgxray mcp` (connect-time MCP adapter) | 0.15 | newest engine; the `--pin`/`--recheck`/`--package` flag surface is still settling |
| `pkgxray mcp-proxy` (per-call runtime gate) | 0.16 | newest surface; policy names and the result-scan defaults may change |
| `pkgxray-cache` server + `PKGXRAY_CACHE_URL` | 0.14 | route set and TTLs may change; explicitly **not** an auth boundary |

### 🔴 Experimental — may change or be removed without a major bump

Useful, but treat as previews. Pin an exact version if you depend on them.

| Surface | Note |
|---|---|
| `pkgxray canary` | **executes** the package's install lifecycle in a throwaway sandbox — opt-in only (`--yes-run-untrusted-code`). The one surface that runs untrusted code; the boundary is still hardening. |
| `browser-extension/` | MV3 unpacked extension; not published to any store, load-unpacked only. |
| hookshot integration (`examples/hookshot/`) | depends on an external project's hook ABI. |

---

## Path to 1.0

1.0 means "the Stable surface above will not break without a major bump." The
checklist to get there:

- [ ] **Calibration gate in CI** — the [benchmark corpus](../benchmark/) runs on
      every PR and fails on a precision/recall regression, so the "0 false
      blocks" claim is enforced, not asserted. *(landed — keep the corpus growing)*
- [ ] **Graduate or drop each Beta surface** — decide `mcp` / `mcp-proxy` /
      cache are Stable (freeze their flags) or keep them Beta with that stated.
- [x] **Freeze the JSON schema** — every `--format json` field is documented in
      one reference ([json-schema.md](json-schema.md)) committed to
      `schemaVersion: 1` (additive-only), with a schema-stability test that fails
      CI if a documented top-level field disappears. *(landed)*
- [ ] **Freeze exit codes and the config schema** — both are already stable in
      practice; make the promise explicit.
- [ ] **`canary` decision** — either harden the execution sandbox to a
      documented threat model or keep it flagged Experimental at 1.0.
- [x] **Publish + provenance** — the [`release` workflow](../.github/workflows/release.yml)
      gates every publish on the tests, the calibration benchmark, and pkgxray's
      own supply-chain `guard`, then ships with `npm publish --provenance` (SLSA
      attestation). *(landed — wire the `NPM_TOKEN` secret to enable publishing.)*
- [ ] **Supported Node range** — CI matrix across the `engines.node` range
      (currently `>=18`) so the floor is tested, not assumed.

Contributions that move a checkbox are the highest-leverage way to help pkgxray
reach 1.0.
