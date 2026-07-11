# Screenshots

Every capture here is output from a real run — nothing is mocked up. This file
records exactly how each one was produced so they can be regenerated.

Terminal captures are rendered with [freeze](https://github.com/charmbracelet/freeze)
(`--language console --theme catppuccin-mocha --window`), hard-wrapped at 100
columns the way a terminal would. Elided regions are marked with `…`.

## cli-guard-block.png

`pkgxray guard` on a local directory materialized from the calibration-corpus
fixture [`benchmark/corpus/malicious/advisory-solana-web3-keytheft.json`](../../benchmark/corpus/malicious/advisory-solana-web3-keytheft.json)
(modeled on the 2024 `@solana/web3.js` compromise), plus a minimal
`package.json`:

```bash
pkgxray guard ./sample-malicious-pkg   # exit code 2
```

Trimmed for size: the quarantine tmp path, the parameter-grade list, and the
INFO findings.

## cli-guard-safe.png

```bash
pkgxray guard npm:express@4.21.0
```

Trimmed: the quarantine tmp path and the findings list after the notes.

## mcp-proxy.png

The real proxy wrapping [`demo-mcp-server.js`](demo-mcp-server.js) (in this
directory) — a minimal stdio MCP server with one benign tool, one tool whose
description carries a prompt injection, and one narrow-purpose tool whose
schema also accepts a `command` parameter:

```bash
pkgxray mcp-proxy -- node docs/screenshots/demo-mcp-server.js
```

The session then sent `initialize` → `tools/list` → `tools/call summarize_page`
→ `tools/call convert_units` as JSON-RPC frames on stdin. The stderr gate log
and the `isError` frame are shown verbatim.

## hookshot.png

The hookshot guard hook (built from [`examples/hookshot/`](../../examples/hookshot/)
inside a hookshot checkout) fed a simulated Claude Code `PreToolUse` event:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"npm install lodash@4.17.11"}}' \
  | pkgxray-guard claude-pre-tool-use \
  | jq -r '.hookSpecificOutput | .permissionDecision, .permissionDecisionReason'
```

`lodash@4.17.11` blocks at the OSV pre-check (published prototype-pollution
vulnerabilities). The three identical `[known-vulnerability]` bullet lines are
collapsed to one plus `…`.

## browser-extension.png

The MV3 popup (`browser-extension/popup.html`) served over localhost and
rendered in headless Chromium at 780×1010, after clicking **Load Sample** —
which loads the built-in risky sample and analyzes it locally.
