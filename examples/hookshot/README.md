# pkgxray × hookshot — guard installs before they run

A [hookshot](https://github.com/CorridorSecurity/hookshot) hook binary that runs
[pkgxray](https://github.com/adamsjack711-ux/pkgxray) supply-chain triage on
recognized registry package-install commands before they run. It denies the
command on a `BLOCK` verdict and hands pkgxray's cited evidence back to the
agent. Conservative parsing has documented gaps; this is defense in depth, not
proof that every install was intercepted.

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
    - **Auto-wrap (default on):** a stdio registration that clears the gate is
      then *denied once* with the same command rewritten so the launcher runs
      behind **`pkgxray mcp-proxy`** — the per-call runtime gate (every
      `tools/call` checked in-memory, manifest re-audited on
      `tools/list_changed`, tool results screened for injection). Hookshot
      decisions can't modify a command in place, so the rewrite rides back as
      the deny reason and the agent re-runs it; the wrapped form is recognized,
      its **inner launcher is still statically scanned**, and it passes. Works
      for launchers the static scan can't vet at all (local binaries, python
      servers) — the runtime gate matters most exactly there. Costs one extra
      agent round-trip (plus a re-scan of the launcher, since each hook
      invocation is a fresh process — `PKGXRAY_CACHE_URL` softens that).
      Disable with `PKGXRAY_HOOK_MCP_WRAP=0`. Requires pkgxray ≥ 0.17 on PATH
      when the host launches the server. `mcp add-json` is gated but not
      auto-wrapped (the launcher lives inside quoted JSON; rebuilding it
      through a tokenizer risks quoting bugs).
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
    Claude) and a review becomes agent context. Once the gate clears, the
    vetted stdio entries are **auto-wrapped in place** to launch behind
    `pkgxray mcp-proxy` (the per-call runtime gate): unlike a command, a config
    file is shared state the hook can rewrite, so the wrap needs no agent
    round-trip (`PKGXRAY_HOOK_MCP_WRAP=0` to disable). The
    `pkgxray-guard wrap-config <file>…` subcommand applies the same rewrite to
    stdio servers already on disk — retrofitting the runtime gate onto servers
    registered before the hook was installed.
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

Use **pkgxray 1.0.3 or newer** and verify it with `pkgxray --version`. The hook
still **degrades safely** across output drift: a missing `file` omits only the
location, while a missing, old, or erroring pkgxray yields `UNKNOWN`, which is
denied under `strict`/`balanced` (never a false allow). Set
`PKGXRAY_HOOK_POLICY` deliberately.

## Install

```bash
# 1. Check out the reviewed Hookshot revision.
git clone https://github.com/CorridorSecurity/hookshot.git
cd hookshot
git checkout --detach 73584ae0e4df38105be9f892130b4c66ea6ce04e

# 2. Copy this directory into the Hookshot tree, then build it.
mkdir -p ./examples/pkgxray-guard
cp -R /absolute/path/to/pkgxray/examples/hookshot/. ./examples/pkgxray-guard/
cd examples/pkgxray-guard
go build -o pkgxray-guard .

# 3. Install an exact pkgxray version for the long-lived hook process.
npm install --global pkgxray@1.0.3
pkgxray --version

# 4. From the Hookshot repository root, build its installer and merge hooks.
cd ../..
go build -o hookshot ./cmd/hookshot
./hookshot install --binary "$PWD/examples/pkgxray-guard/pkgxray-guard"
```

Review the resulting host configuration. The installer merges several adapters;
the files under `configs/` are references for manual setup, not files to replace
an existing host configuration wholesale.

> This module's `replace github.com/CorridorSecurity/hookshot => ../..` is why
> it must be copied into the pinned Hookshot tree before building the complete
> binary. `go test ./pkgxrayguard/...` remains available directly in this repo.

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
| `PKGXRAY_HOOK_MCP_WRAP` | `1` | `0` stops auto-wrapping vetted stdio servers — both `mcp add` launchers and config-file entries — in `pkgxray mcp-proxy` (the per-call runtime gate). |

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
  It is reusable; the [GitHub Actions guide](../../docs/integrations/github-actions.md)
  shows how to call it from another repository using a reviewed commit SHA.

## Remove

1. Remove only the commands ending in `pkgxray-guard ...` from the host's hook
   configuration; preserve unrelated hooks.
2. Delete the `pkgxray-guard` and local Hookshot installer binaries.
3. If no other workflow needs it, run `npm uninstall --global pkgxray`.
4. Restart the agent and verify a harmless shell command no longer invokes the
   hook.

## Troubleshooting

- Run `pkgxray --version`; use 1.0.3 or newer.
- Set `PKGXRAY_BIN` to an absolute executable path because GUI agents often have
  a smaller PATH than an interactive shell.
- Pipe a captured host event to the matching adapter command shown in
  [Try it](#try-it), and inspect stderr without adding secrets.
- `UNKNOWN` means the scanner did not complete. Under strict/balanced this is a
  denial, not a false positive.
- A REVIEW may become deny on hosts without an interactive approval response.
- Run `go test ./pkgxrayguard/...` after changing command parsing or policy.

## Security assumptions

The agent must not be able to edit the hook binary, its host configuration, or
the `PKGXRAY_*` environment supplied by the operator. The host must honor deny
responses. `PKGXRAY_HOOK_DISABLE=1` is an explicit fail-open kill switch and
should not be exposed to agent-controlled commands. The hook invokes registry,
OSV, and optional GitHub/MCP network endpoints; it does not make untrusted
package code safe to execute.

## Notes & limits

- Only registry installs are triaged. Local/VCS installs are out of scope for
  pre-install registry analysis and are allowed through.
- Command parsing is conservative: unusual shapes (deeply nested subshells,
  variable-expanded package names) may not be recognized. Unrecognized → allowed
  rather than wrongly blocked. Treat the hook as defense-in-depth, not a
  complete sandbox.
- `pkgxray guard` reaches the network (registry/OSV/GitHub). Budget ~1s/package;
  tune with `PKGXRAY_GUARD_ARGS` (e.g. `--no-github-diff --no-github`).
