# agentguard

Local CLI + MCP server for triaging whether an AI coding-agent extension, Codex
plugin, Claude Code extension, or npm package is safe to install — from supplied
evidence or by fetching a real npm tarball into a sandboxed quarantine.

## Install

```bash
npm install -g agentguard
# or use one-shot via npx:
npx agentguard guard npm:some-package@1.2.3
```

It is intentionally conservative. It only reports evidence it can cite from
metadata or source text, and it returns one of:

- `safe`: no high- or medium-risk indicators in the provided evidence
- `review`: incomplete evidence or privileged capability needing manual review
- `block`: high-severity indicators such as prompt injection, credential access,
  persistence, obfuscation plus execution, or likely exfiltration

## CLI

```bash
agentguard --file examples/evidence.json
agentguard --format json --file examples/evidence.json
```

Guard an extension before handing it to an agent:

```bash
agentguard guard ./some-local-extension
agentguard guard npm:some-mcp-server@1.2.3 --format json
agentguard guard ./some-local-extension --promote-to ./approved/some-local-extension
agentguard guard npm:is-number@7.0.0 --no-source-scan --format json
```

The guard flow stages the extension in a private quarantine directory, audits
that staged copy, and only promotes it when policy allows. It does not run
`npm install`, package lifecycle scripts, build steps, or extension code.

For npm references, guard order is:

1. Resolve package metadata from the npm registry.
2. Query OSV for the exact package/version.
3. If OSV reports vulnerabilities, block before tarball download.
4. If no vulnerabilities are reported, download and extract the tarball into
   quarantine.
5. Collect source evidence and run the static audit unless `--no-source-scan`
   is set.

The JSON output includes timing fields:

- `stageMs`: local copy or npm metadata resolution
- `vulnerabilityPrecheckMs`: OSV lookup time
- `downloadMs`: tarball download, hash, and extraction time
- `sourceCollectionMs`: capped source-file collection time
- `auditMs`: static audit time

Guard decisions:

- `allow`: safe verdict; promotion can happen
- `review`: do not promote by default; a human should inspect the quarantine
- `block`: high-severity evidence; do not install

By default, only `safe` promotes. Use `--policy allow-review` only when you want
review-grade packages copied into the destination for manual handling.

Input JSON:

```json
{
  "packageName": "example-extension",
  "npmMetadata": {},
  "githubMetadata": {},
  "webPresence": {},
  "sourceFiles": {
    "package.json": "{\"name\":\"example-extension\"}",
    "index.js": "module.exports = {}"
  }
}
```

## MCP Server

Use the stdio server from any MCP-capable agent:

```json
{
  "mcpServers": {
    "agentguard": {
      "command": "agentguard-mcp"
    }
  }
}
```

The server exposes one tool:

- `audit_agent_extension_supply_chain`
- `guard_agent_extension_install`

Tool arguments:

- `packageName`: optional package or extension name
- `npmMetadata`: optional npm metadata object or text
- `githubMetadata`: optional GitHub metadata object or text
- `webPresence`: optional web presence object or text
- `sourceFiles`: required map of file path to source text, or array of file objects
- `outputFormat`: `markdown` or `json`

`guard_agent_extension_install` accepts `reference`, optional `quarantineRoot`,
optional `promoteTo`, `policy`, `force`, and `outputFormat`.

## Browser Extension

The `browser-extension/` folder is a Chrome-compatible Manifest V3 unpacked
extension. It runs entirely locally and requests no browser permissions.

Load the `browser-extension/` folder from a checkout of this repo as an
unpacked extension.

In Chrome:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Choose Load unpacked.
4. Select the `browser-extension` folder above.

In Dia, try the same flow if Dia exposes Chromium extension management. If Dia
does not currently allow unpacked extensions, use Chrome for testing and keep the
MCP/CLI version for agent workflows.

## Local Development

```bash
npm run build:browser
npm test
npm run audit:evidence -- --file examples/evidence.json
```
