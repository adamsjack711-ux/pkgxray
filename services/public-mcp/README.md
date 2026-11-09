# Public MCP

Endpoint: `https://mcp.pkgxray.ca/mcp` (Streamable HTTP, no account/API key).
This is a deliberately bounded public service, not the complete local MCP or
the experimental VM runner.

## Tools

- `audit_agent_extension_supply_chain`: static analysis of caller-supplied
  source, at most 16 files and 16 KiB including names. Uses the same pure engine
  as the browser extension. No package download or execution occurs.
- `check_npm_package_metadata`: exact-version public npm metadata and OSV
  advisory lookup. It does not inspect tarballs, scan dependencies, or verify
  provenance. Missing upstream evidence is reported as unavailable.

Neither tool approves installation. Supplied snippets cannot establish that a
published artifact is safe. Use the local `guard_agent_extension_install` tool
for a complete artifact scan. VM execution, filesystem operations, caller-chosen
URLs, shell commands and user policy changes are not exposed here.

## Connect

For clients supporting remote MCP configuration:

```json
{"mcpServers":{"pkgxray":{"url":"https://mcp.pkgxray.ca/mcp"}}}
```

Some clients require `"type":"http"` alongside `url`; others provide an Add
remote MCP form. Choose Streamable HTTP and no authentication. The `/mcp` URL
is a protocol endpoint; opening it in a browser returns HTTP 405. `/health`
returns service information.

Local alternative:

```json
{"mcpServers":{"pkgxray":{"command":"npx","args":["--yes","--package","pkgxray@1.2.1","pkgxray-mcp"],"env":{"PKGXRAY_MCP_ALLOWED_ROOTS":"/absolute/path/to/project"}}}}
```

## Privacy and limits

Submitted source is processed on Cloudflare. Do not send real credentials or
private code without permission. The application does not intentionally log or
persist source bodies or reports. Cloudflare can retain request metadata.
Package identity is sent to npm and OSV for metadata checks. No user credentials
are forwarded. Responses are `no-store` and include explicit evidence gaps.

Requests are capped at 24 KiB and responses at 128 KiB. Inbound bodies have a
5-second deadline; upstream calls have a 6-second deadline and a 256 KiB bound.
Redirects are refused. JSON-RPC batching and compressed request bodies are not
supported. Only configured browser origins are accepted; native MCP clients
normally omit Origin. Tool annotations are descriptive, not security controls.

Cloudflare rate limit bindings apply 60 requests/minute and 10 valid scans/minute
per client IP, per Cloudflare location. They are approximate abuse controls, not
global quotas; shared IPs share limits. Limits failing to initialize deny scans.
Free Workers account limits may also interrupt or reject expensive analysis;
an interrupted request is never a safety result. This deployment does not create
a paid plan, containers, persistent storage or a VM service.

## Development and validation

```sh
npm ci --ignore-scripts
npm test
npm run types
npm run dry-run
npm run dev
node test/smoke.mjs http://127.0.0.1:8787/mcp
```

The build checks and reuses `browser-extension/auditor.browser.js`, including
the bundled parser's license. Node-only optional modules are unavailable.
The Worker imports neither the local MCP transport nor the VM backend.
The generated files and local dependencies are excluded from git.

Deploy with `npm run deploy`, then run:

```sh
node test/smoke.mjs https://mcp.pkgxray.ca/mcp
```

The smoke test uses inert supplied source and public package metadata. It never
executes those package samples. Rate-limit tests should be run sparingly and
separately from normal availability tests.

Rollback uses `wrangler rollback <previous-version-id>` after inspecting
`wrangler versions list`. The npm release and official Registry descriptor
have their own release and publication procedures.
