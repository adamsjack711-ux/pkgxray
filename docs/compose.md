# Compose: cross-package JavaScript analysis

`pkgxray compose` (also `pkgxray-compose`) traces data between packages and
combines those connections with Package Xray's package findings. It is an
experimental part of this repository, migrated from `package-compose-ray`.
It is available from this checkout; the published `pkgxray@1.2.1` does not yet
include it. There is no second package to install or scanner path to configure.

## Run from this checkout

```sh
node bin/audit.js compose /path/to/source-snapshot --entry index.js --json
# Equivalent executable:
node bin/compose.js /path/to/source-snapshot --entry index.js --json
# Reproducible synthetic examples with both engines:
npm run demo:compose
```

The input needs an npm `package-lock.json` v2/v3 and matching local package
sources at their locked paths. No packages are installed or downloaded. Target
code and lifecycle scripts are never executed. Use an already prepared, stable
source snapshot; do not install unknown dependencies just to run this command.

The combined report retains each engine's findings, gaps, selected file hashes,
and package identities. A package BLOCK survives a clear connection scan.
Otherwise the result remains REVIEW because selected-entry analysis does not
establish full coverage. `authorization.installAllowed` is always `false`.
Exit `2` means block or invalid usage; `3` means review. The explicitly requested
`--flow-only` mode retains the original flow report and exits `0` for no modeled
flow, `1` for findings, or `2` for incomplete analysis/invalid usage; its `0` is
not a safety verdict. The historical component CLI also accepts `--pkgxray` to
select trusted scanner code for compatibility testing; normal use needs no override.

## Local MCP setup

Add these settings to your local stdio MCP host configuration, using absolute
paths for your checkout and approved source snapshots:

```json
{
  "mcpServers": {
    "pkgxray": {
      "command": "node",
      "args": ["/absolute/path/to/pkgxray/bin/mcp-server.js"],
      "env": {
        "PKGXRAY_COMPOSE": "1",
        "PKGXRAY_MCP_ALLOWED_ROOTS": "/absolute/path/to/source-snapshots"
      }
    }
  }
}
```

This advertises `analyze_package_composition`. Arguments:

```json
{
  "projectPath": "/absolute/path/to/source-snapshots/my-app",
  "entry": "index.js",
  "outputFormat": "json"
}
```

`outputFormat` may also be `markdown` (default). The operator can restrict
`.pkgxray.json` to `{"schemaVersion":1,"mcp":{"tools":["compose"]}}`.
The enable flag is required even with that allowlist. Without an explicit roots
environment variable, the server's startup directory is the approved root.
Multiple roots use `:` on Unix or `;` on Windows. Callers cannot enable the tool,
change roots, choose executable scanner code, or raise budgets. Current policy
is checked on every call. This is available only in the local MCP server, not
on the hosted public MCP endpoint.

A dedicated worker keeps parsing off the MCP event loop. One composition scan
runs per server at a time; simultaneous calls get a busy error and may retry.
The worker has a 30-second deadline and 256 MiB V8 heap limit; cancellation
terminates it. Worker failures return REVIEW with an explicit gap. Existing
4 MiB MCP response limits still apply. The worker is a resource boundary, not an
OS sandbox. Reports can contain source snippets: authorize only folders whose
contents you intend to share with the MCP host.

## Limits and evidence

CommonJS and a bounded ESM subset are supported. Dynamic loading, native modules,
unsupported syntax and missing files create gaps. Registry archive integrity,
vulnerability checks, provenance checks and full application coverage are not
provided by this mode. Static symlinks within the source tree are rejected;
filesystem checks do not confine a hostile writer concurrently replacing parent
directories. Scan stable snapshots under operator control.

Source lives in [components/compose](../components/compose/README.md), including
its original examples, research, third-party notices and Git history. The
[v0.4 integration contract](../components/compose/docs/integration.md),
[language coverage](../components/compose/docs/esm.md),
[limits](../components/compose/docs/reference.md) and
[research baseline](../components/compose/docs/tapp-baseline.md) retain detailed
prototype context. All new issues and security reports belong to Package Xray.

`npm test` runs both engines' tests, including the real bundled scanner adapter.
`npm run test:compose` runs the composition tests alone. The main push/PR workflow
includes component changes across the supported Node and OS matrix. No standalone
Compose release or workflow is required. Distribution checks include the vendored
parser and bind Compose runtime files into Package Xray's build identity.
