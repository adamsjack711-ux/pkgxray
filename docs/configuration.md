# Configuration — `.pkgxray.json`

One human-authored policy file, read by **every** pkgxray surface — the CLI
(`guard` / `audit` / `recheck`), the MCP server, the proxy, and the install
hook. Because every surface loads the *same* file through the *same* loader
(`src/config.js`), your policy can never drift per-surface.

`.pkgxray.json` is distinct from `.pkgxray.lock`:

| File | Author | Holds |
|---|---|---|
| `.pkgxray.json` | you | **intent** — policy, allowlist, muted checks |
| `.pkgxray.lock` | pkgxray | **state** — computed verdicts, triage decisions, MCP pins |

## The governing rule: tighten freely, loosen loudly

- **Zero config is fully safe.** An absent or empty file means maximum
  strictness. You never *have* to configure anything.
- You may make the policy **stricter** without limit.
- You may **loosen** it (allow a package, mute a check) only explicitly, and
  every loosening is printed in the report — never silent.

Two invariants are enforced in code, not by convention:

1. **An `allow` entry must be pinned** to `name@version` **and** a `sha256`. A
   bare name would blanket-trust every future version — exactly how a trojaned
   update gets in. Un-pinned allows are dropped with a warning.
2. **A published vulnerability can never be muted or allowed away.** OSV
   `known-vulnerability` findings always surface. You can vouch for a package's
   code; you cannot vouch away a CVE.

## Precedence

```
DEFAULTS  <  ./.pkgxray.json  <  ./.pkgxray.local.json  <  env vars  <  CLI flags
   (safe)      (committed,          (gitignored,            PKGXRAY_*
                team-shared)         personal)
```

`allow` and `mute` lists **concatenate** across layers (your local file *adds*
entries); scalar fields are replaced. The project file is found by walking up
from the working directory, so it applies to a whole repo/monorepo.

## Fields

| Field | Values | Default | Meaning |
|---|---|---|---|
| `policy` | `safe-only` \| `allow-review` | `safe-only` | Whether review-grade packages may be promoted. `allow-review` is a loosening and warns. |
| `failOn` | `block` \| `review` \| `never` | `review` | CI exit threshold. `review` fails the run (exit 3) on review, exit 2 on block. `block` only fails on block. |
| `scanErrorPolicy` | `fail-closed` \| `fail-open` | `fail-closed` | What a scan that errors/times out maps to. Fail-closed → `review`, never silently safe. |
| `allow[]` | see below | `[]` | Pinned per-artifact allowlist. |
| `mute[]` | see below | `[]` | Suppress specific check categories in scope. |
| `mcp` | see below | stricter defaults | The MCP-server view of the policy. |

### `allow[]` — pinned per-artifact allowlist

```json
{ "pkg": "left-pad@1.3.0", "sha256": "e0b0…", "reason": "reviewed 2026-07", "expires": "2026-10-01" }
```

- `pkg` **(required)** — `name@version` (scoped names ok: `@scope/x@2.0.0`).
- `sha256` **(required)** — the artifact digest you reviewed. The allow applies
  **only** when the scanned package's digest matches. A different version or
  different bytes → the allow does not apply and the package is scanned normally.
- `reason` — shown in the report.
- `expires` — ISO date; after it, the entry is ignored (and noted).

An allow forces the verdict to `safe` — **except** when a `known-vulnerability`
survives, in which case it is refused and the package still blocks.

### `mute[]` — suppress a check in scope

```json
{ "check": "lonely-maintainer", "scope": "@myorg/*", "files": "src/**", "reason": "internal registry" }
```

- `check` **(required)** — a finding category (e.g. `install-hook`,
  `lonely-maintainer`, `github-stale`, `npm-vs-github-divergence`). Cannot be
  `known-vulnerability`.
- `scope` — glob on the package name (default `*`).
- `files` — optional glob on the finding's file path.
- `reason` — shown in the report.

A muted finding is **kept visible** in the report (tagged `muted`) but excluded
from the verdict, and the report always prints `Config: N finding(s) muted…`.

### `mcp` — the agent-deployment view

The MCP server reads the **same** config, but an agent acts on the verdict
autonomously, so its defaults start stricter.

```json
{ "tools": ["audit", "recheck"], "policy": "safe-only", "packageScanFirst": true, "timeoutMs": 15000 }
```

- `tools` — which tools the server exposes (`null`/omitted = all).
- `packageScanFirst` — scan a server's package before connecting. On by default;
  disabling it warns loudly.
- `policy`, `timeoutMs` — as above, scoped to the MCP surface.

## How a surface integrates it

Every entrypoint does the same three things:

```js
const cfg = require("./config");

// 1. load once at startup
const { config, warnings } = cfg.loadConfig({ cwd });
warnings.forEach((w) => process.stderr.write(`pkgxray: ${w}\n`)); // loud

// 2. apply to each report before deciding
const adjusted = cfg.applyConfig(report, { config, packageName, version, sha256, evidence });

// 3. surface the effects + derive the exit code
report.lines.push(...cfg.renderConfigEffects(adjusted.configEffects));
process.exitCode = cfg.exitCodeForVerdict(adjusted.verdict, config);

// scan errors route through the config's fail policy, never a bare "safe":
catch (err) { verdict = cfg.verdictForScanError(config); }
```

See `.pkgxray.example.json` for a complete annotated example.
