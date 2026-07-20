# Coding-agent integrations

pkgxray can be exposed as an MCP tool or called as a command. Those integrations
are **advisory unless the host has an execution hook**: an instruction can ask
an agent to scan first, but cannot prove that every install was intercepted.
For an actual pre-execution gate, use the experimental
[Hookshot integration](../../examples/hookshot/).

All examples pin `pkgxray@1.0.3`. Advance that version only through a reviewed
release update.

## Shared agent policy

Use this text in the product-specific instruction file:

```markdown
Before adding, installing, executing, or connecting to a third-party npm
package or MCP server:

1. Call `guard_agent_extension_install` with an exact `npm:name@version`
   reference. For an MCP server package, scan the package before connecting.
2. Proceed only on SAFE/allow.
3. On REVIEW, stop and ask a human to inspect the cited evidence.
4. On BLOCK, do not install or execute it.
5. If pkgxray is unavailable or errors, report that the scan did not complete;
   never describe an unscanned package as safe.

Do not weaken pkgxray policy, pass `force`, suppress findings, or edit its
operator-controlled configuration unless the user explicitly asks.
```

This policy is prompt guidance, not a sandbox. A malicious prompt or model error
can ignore it.

## OpenAI Codex

### Installation and configuration

Codex supports project-scoped MCP configuration in `.codex/config.toml` for
trusted projects:

```toml
[mcp_servers.pkgxray]
enabled = true
required = true
command = "npx"
args = ["--yes", "--package", "pkgxray@1.0.3", "pkgxray", "serve-mcp"]
env = { PKGXRAY_MCP_ALLOWED_ROOTS = "/absolute/path/to/project" }
```

Put the [shared policy](#shared-agent-policy) in the repository's `AGENTS.md`.
Codex CLI and the IDE extension share Codex configuration.

### Minimal working example

Ask: `Use pkgxray to scan npm:express@4.21.0 before suggesting installation.`
Confirm `/mcp verbose` lists the pkgxray tools and that the agent calls
`guard_agent_extension_install`.

### Blocking and review

The MCP server returns evidence, but `AGENTS.md` is advisory. It does not
intercept a Codex shell command. Hookshot's Codex `PreToolUse` adapter can deny
the command; under Hookshot's balanced policy, REVIEW is denied because Codex
has no interactive hook approval response.

### Removal, limitations, and troubleshooting

- Remove the `[mcp_servers.pkgxray]` table and pkgxray lines from `AGENTS.md`.
- Run `codex mcp list` or `/mcp verbose` if tools are absent.
- Project `.codex/config.toml` loads only for a trusted project.
- Test `npx --yes --package pkgxray@1.0.3 pkgxray serve-mcp` directly if startup
  fails.
- Codex controls tool selection; MCP availability alone is not enforcement.

Security assumption: the user controls `.codex/config.toml`, `AGENTS.md`, the
exact package version, and `PKGXRAY_MCP_ALLOWED_ROOTS`.

Official references:
[MCP](https://developers.openai.com/codex/mcp) and
[AGENTS.md](https://developers.openai.com/codex/guides/agents-md).

## Claude Code

### Installation and configuration

Add a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "pkgxray": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "pkgxray@1.0.3",
        "pkgxray",
        "serve-mcp"
      ],
      "env": {
        "PKGXRAY_MCP_ALLOWED_ROOTS": "${CLAUDE_PROJECT_DIR:-.}"
      }
    }
  }
}
```

Put the [shared policy](#shared-agent-policy) in `CLAUDE.md`. Claude Code asks
the user to approve project-scoped MCP servers before first use.

### Minimal working example

Run `claude mcp list`, approve the project server interactively, then ask:
`Scan npm:express@4.21.0 with pkgxray and explain the verdict.`

### Blocking and review

The MCP and `CLAUDE.md` path is advisory. Claude Code can enforce command hooks,
but writing a correct package-command parser is non-trivial; use the tested
Hookshot adapter instead of a substring-matching shell hook. Hookshot maps BLOCK
to deny and REVIEW according to its selected policy.

### Removal, limitations, and troubleshooting

- Remove `pkgxray` from `.mcp.json` and the policy from `CLAUDE.md`.
- Use `claude mcp get pkgxray` for status.
- Run `claude mcp reset-project-choices` to clear a rejected/approved choice.
- If startup fails, test the exact `npx` command outside Claude Code.
- Project owners can edit `.mcp.json`; review changes before approval.

Security assumption: the user approves the server and controls `.mcp.json`,
`CLAUDE.md`, the pinned version, and allowed root. No secret is required.

Official references:
[MCP](https://docs.anthropic.com/en/docs/claude-code/mcp) and
[settings/hooks](https://docs.anthropic.com/en/docs/claude-code/hooks).

## Cursor

### Installation and configuration

Add `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pkgxray": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "pkgxray@1.0.3",
        "pkgxray",
        "serve-mcp"
      ],
      "env": {
        "PKGXRAY_MCP_ALLOWED_ROOTS": "${workspaceFolder}"
      }
    }
  }
}
```

Create `.cursor/rules/pkgxray.mdc`:

```markdown
---
description: Scan third-party packages before installation
alwaysApply: true
---

Before installing or executing an npm package or MCP server, follow the pkgxray
policy documented in docs/integrations/coding-agents.md#shared-agent-policy.
```

### Minimal working example

Open Cursor MCP settings and confirm pkgxray is connected. Ask:
`Call pkgxray before adding express@4.21.0.`

### Blocking and review

Cursor rules guide the agent but do not intercept every shell command. The
Hookshot `beforeShellExecution` adapter is the enforcement option: it denies
BLOCK and handles REVIEW according to policy.

### Removal, limitations, and troubleshooting

- Remove the `pkgxray` entry from `.cursor/mcp.json` and delete the rule.
- Restart/reload MCP servers after editing configuration.
- Use Cursor's MCP status/logs, then run the `npx` command directly.
- An absolute root avoids granting access based on an application-wide CWD.

Security assumption: project MCP configuration and rules are reviewed before
trust; the operator controls root access and the pinned npm version.

Official references:
[MCP](https://cursor.com/docs/mcp) and
[rules](https://cursor.com/docs/rules).

## Windsurf / Cascade

### Installation and configuration

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "pkgxray": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "pkgxray@1.0.3",
        "pkgxray",
        "serve-mcp"
      ],
      "env": {
        "PKGXRAY_MCP_ALLOWED_ROOTS": "/absolute/path/to/project"
      }
    }
  }
}
```

Put the [shared policy](#shared-agent-policy) in the repository's `AGENTS.md`
(or a workspace rule under `.devin/rules/`, with `.windsurf/rules/` as the
legacy fallback).

### Minimal working example

Open Windsurf Settings → Cascade → MCP Servers, confirm pkgxray is connected,
then ask: `Scan npm:express@4.21.0 before proposing an install command.`

### Blocking and review

MCP plus a rule is advisory. Hookshot's `pre-run-command` adapter is the
enforcement path and maps pkgxray verdicts through its selected policy.

### Removal, limitations, and troubleshooting

- Remove `pkgxray` from `mcp_config.json` and remove the policy rule.
- Reopen Cascade's MCP settings after editing raw configuration.
- Team allowlists may reject a command/args combination that is not explicitly
  approved.
- Test the exact `npx` command directly if the server does not connect.

Security assumption: user or team policy controls the MCP allowlist, exact
command, environment, allowed root, and workspace instructions.

Official references:
[MCP](https://docs.windsurf.com/windsurf/cascade/mcp) and
[rules](https://docs.windsurf.com/windsurf/cascade/memories).

## Generic MCP clients

### Installation and configuration

Adapt this standard stdio shape to the client's MCP configuration:

```json
{
  "mcpServers": {
    "pkgxray": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "pkgxray@1.0.3",
        "pkgxray",
        "serve-mcp"
      ],
      "env": {
        "PKGXRAY_MCP_ALLOWED_ROOTS": "/absolute/path/to/project"
      }
    }
  }
}
```

### Minimal working example

Call `tools/list`, then call `guard_agent_extension_install` with:

```json
{ "reference": "npm:express@4.21.0", "outputFormat": "json" }
```

### Blocking, removal, limitations, and troubleshooting

- Treat `decision: allow` as SAFE, `review` as human review, and `block` as
  rejection. Transport errors are not SAFE.
- Remove the server object to uninstall the integration; `npx` leaves only its
  normal temporary cache.
- Verify newline-delimited stdio, Node 18+, and the exact launch command.
- The client decides whether it obeys a verdict; MCP itself is not an install
  interceptor.

Security assumption: the client launches commands without a shell, preserves
JSON argument boundaries, and does not let tool callers alter the process
environment or allowed roots.

## Generic command-running agents

### Installation and configuration

No global installation is required. Add the [shared policy](#shared-agent-policy)
to the agent's durable instruction file and permit this exact command:

```bash
npx --yes pkgxray@1.0.3 guard npm:<name>@<version> --format json
```

### Minimal working example

```bash
npx --yes pkgxray@1.0.3 guard npm:express@4.21.0 --format json
```

### Blocking, removal, limitations, and troubleshooting

- Exit `0` permits, `3` requires review, and `2` blocks. Any other exit is a
  scanner failure and must not be treated as SAFE.
- Remove the instruction and command permission to remove the integration.
- Shell aliases and prompt instructions are advisory. Use Hookshot or an
  equivalent host execution hook for interception.
- The scan uses npm, OSV, and optional GitHub network access.

Security assumption: the agent cannot rewrite the pinned scanner command or
skip nonzero exit handling without user-visible approval.

## Hookshot enforcement

Hookshot is the only integration in this repository that claims command
interception. It parses package-manager commands before execution and invokes
pkgxray for each registry package.

### Installation and configuration

Follow the [Hookshot guide](../../examples/hookshot/) to build
`pkgxray-guard`, install an exact pkgxray version, and merge the host-specific
hook config. Select `strict`, `balanced`, or `permissive` explicitly.

### Minimal working example

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"npm install left-pad"}}' \
  | ./pkgxray-guard claude-pre-tool-use
```

### Blocking and review

BLOCK is denied under every policy. REVIEW is denied under strict, asks under
balanced when the host supports approval, and passes under permissive. Scanner
failure is denied under strict/balanced. Immediate-execution commands never
silently fail open.

### Removal, limitations, and troubleshooting

- Remove only the pkgxray-guard entries from the host's hook config, delete the
  hook binary, and optionally uninstall the global pkgxray CLI.
- Run the adapter manually with a captured host event and set
  `PKGXRAY_BIN` to an absolute path when PATH differs inside the host.
- Conservative parsing cannot recognize every shell/subshell/variable shape;
  this is defense in depth, not a complete sandbox.
- Local and VCS package specs are not registry-triaged.

Security assumption: the hook config and binary are outside agent write access,
the host honors deny responses, and the fail-open
`PKGXRAY_HOOK_DISABLE=1` switch is operator-controlled.
