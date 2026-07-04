# pkgxray × hookshot — guard installs before they run

A [hookshot](https://github.com/CorridorSecurity/hookshot) hook binary that runs
[pkgxray](https://github.com/adamsjack711-ux/pkgxray) supply-chain triage on any
package an AI coding agent tries to install — **before a single line of it runs**
— and denies the command on a `BLOCK` verdict, with pkgxray's cited evidence
handed back to the agent.

hookshot supplies the cross-agent hook surface (Claude Code, Cursor, Windsurf
Cascade, Factory Droid, OpenAI Codex); pkgxray supplies the detection engine
(OSV vuln pre-check, sandboxed quarantine, static heuristics, prompt-injection
and obfuscation detection, GitHub provenance cross-check). This directory is the
glue.

```
agent runs:  npm install left-pad evil-pkg@1.2.3
                       │
             OnBeforeExecution (hookshot)
                       │  parse install targets
                       ▼
             pkgxray guard npm:evil-pkg@1.2.3 --format json
                       │  SAFE / REVIEW / BLOCK  (+ cited findings)
                       ▼
             BLOCK → DenyExecution("pkgxray blocked …: credential-access …")
```

## What it does

- **`OnBeforeExecution`** — parses the agent's shell command for package
  installs and runs `pkgxray guard` on each one:
  - `npm|pnpm|yarn|bun install|i|add <pkg…>` (incl. `yarn global add`)
  - `npx` / `bunx` / `pnpm dlx` / `bun x` runners
  - `claude mcp add <name> -- <launcher>` (audits the launcher's package)
  - **MCP server registrations** (`… mcp add` / `mcp add-json`, CLI-agnostic):
    - a stdio launcher (`npx some-server`, with or without `--`) takes the
      **static package scan** — the hook never spawns the server itself
      (package-scan-first; run `pkgxray mcp` yourself for the connect-time
      manifest audit once the package clears);
    - a streamable-HTTP URL is probed with **`pkgxray mcp <url>`** — read-only
      handshake + `tools/list`, then the manifest audit (prompt injection in
      tool descriptions, concealed instructions, capability-surface mismatch).
      Connecting is a network fetch the agent was about to make anyway — no
      local code executes. Disable with `PKGXRAY_HOOK_MCP_PROBE=0` (the add
      then surfaces as **review**, not silently allowed);
    - a legacy SSE transport (or unreadable `add-json` config) can't be
      probed — surfaced as **review-worthy**.
  - Git / tarball / HTTP URL specs (`git+https://…`, `git@…`, `https://…​.tgz`)
    can't be resolved by registry triage, so they're surfaced as **review-worthy**
    (never silently allowed).
  - Local paths (`./x`, `file:`, `link:`, `workspace:`) and bare `npm ci` /
    `npm install` are skipped — that code is already local/visible, or there's
    no per-package ref to triage.
- **`OnAfterFileEdit`** — two jobs:
  - **MCP config files** *(on by default)* — `mcp add` isn't the only way a
    server gets registered: an agent can write `.mcp.json` (Claude Code),
    `.cursor/mcp.json` / `.vscode/mcp.json`, Windsurf's `mcp_config.json`, or
    `claude_desktop_config.json` directly and bypass the execution gate. The
    hook diffs the edit for **added/changed server entries** and gates each one
    exactly like an `mcp add`: launcher command → static package scan, http(s)
    URL → `pkgxray mcp` probe, an entry it can't read → **review** (never a
    silent allow). Env-only or formatting edits re-triage nothing. A post-edit
    hook can't undo the write, so a BLOCK becomes a file-edit block (honored by
    Claude) and a review becomes agent context.
  - **Dependency manifests** *(opt-in)* — when the agent edits `package.json`
    or a lockfile, checks it and feeds the verdict back as agent context (or a
    block on Claude for a `BLOCK`). It diffs the edit hunks so it doesn't
    re-triage the whole tree every time:
  - `package.json` — deep-guards **only the newly added/changed deps** (reusing
    the session cache); a formatting/script-only edit triages nothing. Falls
    back to a full-file audit if no added dep can be extracted, so it's never
    less safe than a blanket scan.
  - lockfiles — full-file `pkgxray audit`, which honors the sibling
    `.pkgxray.lock` allow/block memory so already-approved deps don't re-prompt.

The worst verdict across a multi-package command wins.

## Requirements

The hook shells out to the **pkgxray CLI** and depends on this contract:

- `pkgxray guard <ref> --format json` emitting a top-level `decision`
  (`allow`/`review`/`block`) and, for finding locations,
  `report.findings[].file`;
- `pkgxray mcp <url> --format json` (pkgxray ≥ 0.16.0) emitting a top-level
  `verdict`, `manifest.server`/`manifest.tools`, and
  `manifestAudit.findings[]` — used to probe HTTP MCP-server registrations;
- exit codes `2`=block, `3`=review, `0`=safe (used as the fallback when the JSON
  can't be parsed).

This is stable as of **pkgxray ≥ 0.15.0** (≥ 0.16.0 for the MCP probe) — keep
the CLI reasonably current.
pkgxray has no `--version` flag today, so the hook can't probe the version at
runtime; instead it **degrades safely**: a missing `file` just omits the path,
and a missing/old/erroring pkgxray yields `UNKNOWN`, which is denied under
`strict`/`balanced` (never a false allow). Set `PKGXRAY_HOOK_POLICY` accordingly.

## Install

```bash
# 1. Build the hook binary (from inside the hookshot fork).
cd examples/pkgxray-guard
go build -o pkgxray-guard .

# 2. Make sure pkgxray is on PATH (or point PKGXRAY_BIN at it).
npm install -g pkgxray        # or: export PKGXRAY_BIN=/path/to/pkgxray

# 3. Wire it into your agent(s). Either use hookshot's installer…
hookshot install --binary ./pkgxray-guard
# …or copy a config from ./configs/ into your agent's settings and set the
#    absolute path to the built binary (see configs/claude-settings.json etc.).
```

> This module ships a `replace github.com/CorridorSecurity/hookshot => ../..`
> so it builds offline against the parent repo when it lives in the fork at
> `examples/pkgxray-guard/`. Building it standalone? Drop the `replace` line and
> `go get github.com/CorridorSecurity/hookshot@latest`.

## Configuration

All via environment variables (the hook reads them at startup):

| Variable | Default | Meaning |
|---|---|---|
| `PKGXRAY_BIN` | `pkgxray` | Path to the pkgxray CLI. |
| `PKGXRAY_HOOK_POLICY` | `balanced` | `strict` \| `balanced` \| `permissive` (see below). |
| `PKGXRAY_HOOK_DISABLE` | — | `1` bypasses all checks (fail-open kill switch). |
| `PKGXRAY_HOOK_AUDIT_LOCKFILES` | — | `1` enables the `OnAfterFileEdit` lockfile audit. |
| `PKGXRAY_GUARD_ARGS` | — | Extra flags passed to `pkgxray guard`, e.g. `--no-github-diff`. |
| `PKGXRAY_CACHE_URL` | — | Forwarded to pkgxray so registry/GitHub fetches route through a shared cache server across runs. |
| `PKGXRAY_HOOK_CONCURRENCY` | `8` | Max packages guarded concurrently within one command. |
| `PKGXRAY_HOOK_MCP_PROBE` | `1` | `0` skips the `pkgxray mcp <url>` probe on HTTP MCP-server adds; they then surface as **review** instead of being probed. |

When a single command installs several packages (`npm i a b c …`), they are
guarded **concurrently** (bounded by `PKGXRAY_HOOK_CONCURRENCY`), so the gate's
latency is roughly the slowest package rather than the sum — a 20-package
install drops from ~10s to ~1–2s. Lower the cap to be gentler on rate-limited
upstreams; raise it if pkgxray runs against a local cache server.

The hook also memoizes verdicts per exact `ref@version` for the lifetime of its
process (one agent session): re-installing the same package reuses the first
verdict instead of re-scanning (~1.3–1.5s cold each). An `UNKNOWN`/errored
result is never cached, so a transient failure can't pin a wrong answer; a
different version is always re-scanned.

### Policies

| Verdict | `strict` | `balanced` (default) | `permissive` |
|---|---|---|---|
| `BLOCK`  | deny | deny | deny |
| `REVIEW` | deny | **ask** | allow |
| `UNKNOWN` (pkgxray failed to run) | deny | deny | allow |
| `SAFE`   | allow | allow | allow |

**Execute-immediately fail-mode.** `npx` / `bunx` / `pnpm dlx` / `bun x` run
package code the instant it resolves, with no persistent install to inspect
afterwards. So even under `permissive`, an immediate-exec spec whose verdict is
`UNKNOWN` (pkgxray errored) or `REVIEW` (e.g. an unvettable VCS/URL) is escalated
to **ask** rather than allowed — it never fails open. A *persistent* install
(`npm i …`) still follows the table above.

`balanced` never fails open on a broken pkgxray: if the CLI is missing or
errors, the verdict is `UNKNOWN` and the install is denied. On OpenAI Codex,
hookshot rewrites an `ask` decision to a deny (Codex has no approval prompt), so
`REVIEW` under `balanced` blocks there too.

## Out-of-band recheck

The install gate only ever sees *new* installs. Dependencies you already have
can go bad later — a maintainer takeover, a trojaned patch release. Hookshot
dispatches only event hooks (there is no periodic entry point), so re-evaluating
already-installed deps is exposed as a plain subcommand of the same binary that
a cron/CI step (or a human) invokes:

```bash
pkgxray-guard recheck                 # auto-detect the project lockfile in CWD
pkgxray-guard recheck package-lock.json
```

It shells out to `pkgxray recheck <lockfile> --format json` (all drift logic
lives in the engine — this is a thin orchestration layer) and surfaces the
result through the **same policy and verdict vocabulary** as the gate:

- **regressed** deps — a dependency you already have got worse since install →
  folded through `DecideAll` exactly like a flagged install (block → deny/notify,
  review → ask under balanced).
- **version drift** (a newer-but-flagged version exists) — informational only;
  it never enters the fold or moves the exit code.

Fail-mode is honoured: a recheck that can't reach the engine is `Unknown`, which
denies under `strict`/`balanced` and is allowed only under `permissive` — never a
silent "nothing regressed". `PKGXRAY_CACHE_URL` is forwarded so the recheck shares
the gate's warm cache. Exit codes mirror the gate: `0` clean, `3` regressed to
review, `2` regressed to block (or engine unreachable under a fail-closed policy).

## Layout

```
examples/pkgxray-guard/
├── main.go              hookshot handler registration + env config + `recheck` subcommand
├── helpers.go           lockfile detection + pkgxray CLI runner
├── pkgxrayguard/        pure, stdlib-only, unit-tested core
│   ├── parse.go         shell command → []InstallSpec
│   ├── guard.go         run `pkgxray guard`, map verdict + reasons
│   ├── policy.go        verdict × policy → allow/ask/deny
│   ├── cache.go         per-session verdict memo (keyed by ref@version)
│   ├── manifest.go      diff a package.json edit → added/changed deps
│   ├── recheck.go       run `pkgxray recheck`, map drift → surfaced report
│   └── *_test.go        table tests + fake-pkgxray exec tests (offline)
└── configs/             ready-to-edit hook configs per agent
    ├── claude-settings.json   Claude Code   (~/.claude/settings.json)
    ├── cursor-hooks.json      Cursor        (.cursor/hooks.json)
    ├── codex-hooks.json       OpenAI Codex  (~/.codex/hooks.json)
    ├── droid-settings.json    Factory Droid (~/.factory/settings.json)
    └── cascade-hooks.json     Windsurf Cascade (~/.codeium/windsurf/hooks.json)
```

The `pkgxrayguard` package has no third-party dependencies, so
`go test ./pkgxrayguard/...` runs without the hookshot module or a network.

## Try it

```bash
go test ./pkgxrayguard/...

# Simulate a Claude PreToolUse event (deny path depends on the real package):
echo '{"tool_name":"Bash","tool_input":{"command":"npm install left-pad"}}' \
  | ./pkgxray-guard claude-pre-tool-use
```

## CI

Two workflows in this repo's [`.github/workflows/`](../../.github/workflows/):

- **`hookshot-guard-ci.yml`** builds, vets, and tests this module against the
  published hookshot module on every change under `examples/hookshot/`.
- **`pkgxray-audit.yml`** audits lockfiles with pkgxray and fails on a `BLOCK`.
  It's reusable — call it from any repo:

  ```yaml
  jobs:
    supply-chain:
      uses: adamsjack711-ux/pkgxray/.github/workflows/pkgxray-audit.yml@main
      with:
        fail-on: block   # or "review" to also fail on REVIEW verdicts
  ```

## Notes & limits

- Only registry installs are triaged. Local/VCS installs are out of scope for
  pre-install registry analysis and are allowed through.
- Command parsing is conservative: unusual shapes (deeply nested subshells,
  variable-expanded package names) may not be recognized. Unrecognized → allowed
  rather than wrongly blocked. Treat the hook as defense-in-depth, not a
  complete sandbox.
- `pkgxray guard` reaches the network (registry/OSV/GitHub). Budget ~1s/package;
  tune with `PKGXRAY_GUARD_ARGS` (e.g. `--no-github-diff --no-github`).
