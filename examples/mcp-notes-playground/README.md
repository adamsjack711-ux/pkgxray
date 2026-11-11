# Fieldnotes — local MCP playground

A small dependency-free visual notes board with add, pin, search, and delete. Notes stay in browser localStorage. No notes are sent to MCP; checks inspect the app's source files and an isolated fixture.

From this directory:

```sh
node server.cjs
```

Open **http://127.0.0.1:4817**. Use `PORT=4818 node server.cjs` if the default port is occupied. Stop with Ctrl-C. The local server launches this checkout's real `bin/mcp-server.js` over stdio and limits its filesystem roots to this playground.

## Try the tools

Click **Run safety checks** to make six real MCP tool calls:

1. `audit_agent_extension_supply_chain`: inspect the browser app's source.
2. Repeat the same audit: observe a raw-analysis cache hit.
3. `guard_agent_extension_install`: inspect the local `dist/` directory, without promotion or remote checks.
4. `audit_lockfile_supply_chain`: inspect `checks/package.json` offline.
5. `triage_lockfile_supply_chain`: record a **block** for the dummy dependency in `checks/.pkgxray.lock`.
6. Audit the fixture again to display its current evidence.

The app never installs the dummy dependency, makes registry/advisory requests, promotes packages, or submits Proceed choices. REVIEW remains pending. A triage block is a recorded operator decision; it does not rewrite the underlying scan verdict. See **View tool evidence** for full results. The latest run is saved to ignored `checks/latest-run.json`; the generated fixture lock is ignored too.

The localhost API accepts only fixed source/fixture paths. It rejects foreign Origin/Host values and permits one check sequence at a time. There is no remote MCP endpoint, authentication system, or cloud deployment; this is a local development playground.

## Verification performed

- Syntax-checked the server and browser JavaScript.
- Confirmed the real MCP handshake and all four advertised tools.
- Ran six tool calls and asserted that repeated analysis uses the cache.
- Confirmed cross-origin check requests are rejected.
- In Safari: created, pinned, searched, and deleted a disposable note; ran the six checks from the UI and inspected the rendered results.

The first real scan surfaced a `flow-analysis-gap` finding; the UI displays PENDING REVIEW and does not auto-approve it. This is useful follow-up evidence for improving the scanner, not something the playground hides.
