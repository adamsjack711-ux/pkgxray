# Screenshots

Every capture here is output from a real run — nothing is mocked up, trimmed,
or composed in post. This file records exactly how each one was produced so
they can be regenerated.

The terminal stills are unedited [vhs](https://github.com/charmbracelet/vhs)
`Screenshot` captures of live sessions — same tooling, window, font, and warm
earth-tone `stik-latte` theme as the [demo recordings](../demo/README.md).
Regenerate with:

```bash
docs/demo/setup.sh                       # stages fixtures, builds pkgxray-guard
vhs docs/demo/still-mcp-proxy.tape       # → docs/screenshots/mcp-proxy.png
vhs docs/demo/still-hookshot.tape        # → docs/screenshots/hookshot.png
```

The former `cli-guard-block.png` / `cli-guard-safe.png` stills were replaced
by the animated hero GIF and MP4 walkthrough in [`docs/demo/`](../demo/README.md),
which record the same two `pkgxray guard` runs live (same commands, same
calibration-corpus sample).

## mcp-proxy.png

The real proxy wrapping [`demo-mcp-server.js`](demo-mcp-server.js), in this
directory. That server is a minimal stdio MCP server with three tools: one
benign, one whose description carries a prompt injection, and one narrow-purpose
tool whose schema also accepts a `command` parameter.

```bash
./frames.sh | pkgxray mcp-proxy -- node demo-mcp-server.js
```

`frames.sh`, which [`setup.sh`](../demo/setup.sh) writes, sends four JSON-RPC
frames on stdin, one second apart: `initialize`, `tools/list`,
`tools/call summarize_page`, and `tools/call convert_units`. Everything in the
capture is live stdout and stderr, interleaved. You see both strips, the filtered
`tools/list` result where only `convert_units` survives, the `isError` frame from
the denied call, the clean call succeeding, and the session summary with the gate
timing for each call.

## hookshot.png

The hookshot guard hook (built from [`examples/hookshot/`](../../examples/hookshot/)
inside a hookshot checkout — `setup.sh` does this) fed a simulated Claude Code
`PreToolUse` event:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"npm install lodash@4.17.11"}}' \
  | pkgxray-guard claude-pre-tool-use \
  | jq -r '.hookSpecificOutput | .permissionDecision, .permissionDecisionReason'
```

`lodash@4.17.11` blocks at the OSV pre-check (published prototype-pollution
vulnerabilities). The full deny output is shown, repeated bullets and all.

## browser-extension.png

The MV3 popup (`browser-extension/popup.html`) served over localhost and
rendered in headless Chromium at 780×1010. `popup.html?sample` auto-loads and
analyzes the built-in risky sample (the same thing clicking **Load Sample**
does), so the render needs no interaction:

```bash
cd browser-extension && python3 -m http.server 8123 &
chrome-headless-shell --disable-gpu --hide-scrollbars --window-size=780,1010 \
  --virtual-time-budget=5000 --screenshot=docs/screenshots/browser-extension.png \
  "http://127.0.0.1:8123/popup.html?sample"
```

The popup's palette is the same warm earth-tone theme as the CLI captures
(defined in `browser-extension/popup.css`).
