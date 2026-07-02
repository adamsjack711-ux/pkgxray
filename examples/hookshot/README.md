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
  - Git / tarball / HTTP URL specs (`git+https://…`, `git@…`, `https://…​.tgz`)
    can't be resolved by registry triage, so they're surfaced as **review-worthy**
    (never silently allowed).
  - Local paths (`./x`, `file:`, `link:`, `workspace:`) and bare `npm ci` /
    `npm install` are skipped — that code is already local/visible, or there's
    no per-package ref to triage.
- **`OnAfterFileEdit`** *(opt-in)* — when the agent edits `package.json` or a
  lockfile, runs `pkgxray audit` on it and feeds the verdict back as agent
  context (or a block on Claude for a `BLOCK`).

The worst verdict across a multi-package command wins.

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

The hook memoizes verdicts per exact `ref@version` for the lifetime of its
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

## Layout

```
examples/pkgxray-guard/
├── main.go              hookshot handler registration + env config
├── helpers.go           lockfile detection + pkgxray CLI runner
├── pkgxrayguard/        pure, stdlib-only, unit-tested core
│   ├── parse.go         shell command → []InstallSpec
│   ├── guard.go         run `pkgxray guard`, map verdict + reasons
│   ├── policy.go        verdict × policy → allow/ask/deny
│   └── *_test.go        table tests + fake-pkgxray exec tests (offline)
└── configs/             ready-to-edit hook configs per agent
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
