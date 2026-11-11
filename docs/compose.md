# Compose: cross-package JavaScript analysis

`pkgxray compose` (also `pkgxray-compose`) traces data between packages and
combines those connections with Package Xray's package findings. It is an
experimental part of this repository, migrated from `package-compose-ray`.
This document describes the unpublished breaking 2.0 candidate; the 1.3 work
remains a separate held PR. There is no second package to install or scanner path to configure.

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
Partial selected-entry coverage also blocks: it cannot establish complete safety.
`authorization.installAllowed` is always `false`; Compose analysis never
authorizes installation. Decision output uses the binary candidate contract;
exit `2` covers blocked decisions or invalid usage. The explicitly requested
`--flow-only` mode has a separate `analysisStatus` and exits `0` for no modeled
flow, `1` for findings, or `2` for incomplete analysis/invalid usage. Its `0`
is an analysis status, never installation approval or a safety verdict. The historical component CLI also accepts `--pkgxray` to
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
terminates it. Worker failures block with an explicit gap; no manual approval is requested. Existing
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

## Pull-request evidence reports

The **Compose PR evidence** workflow compares a pull request's immutable base
and head snapshots when JavaScript, package manifests, npm lockfiles or report
configuration changes. The job summary shows newly observed dataflow routes,
high/medium package finding signatures, comparable absence counts, and analysis
gaps for both revisions. The `compose-pr-evidence` artifact retains JSON and
Markdown for seven days, including selected-file hashes and scanner identity.
Source snippets are not included in this condensed report.

This is an advisory job, not an installation or merge-approval gate. Findings
do not make the job fail; setup failures do. A green job means the reporting
process ran, not that the PR is safe. The headline retains block evidence and also blocks partial coverage. Reasons
distinguish observed findings from missing evidence; a coverage block is not a
claim of confirmed malware. If either analysis is
incomplete or its evidence truncated, absence comparisons are **unavailable**
(`noLongerObserved: null` in JSON). Newly observed evidence may reflect a baseline
gap rather than introduced behavior. Complete, untruncated selected-source scans
can report **no longer observed** signatures; that still never proves a fix.
Flow signatures compare route labels, package paths, source files and network
destinations; line-number-only shifts do not create new flows. Package finding
signatures include a hash of exact snippet evidence without exposing the snippet,
so changing a risky command in the same file is visible. These are
diagnostic comparisons, not a complete semantic or version-diff analysis.

The scanner, script and `.github/compose-report.json` configuration all come
from the **base SHA**. The head checkout is source data only. No PR dependencies,
lifecycle scripts or target modules are installed or executed. The workflow
uses a read-only repository token, persists no Git credentials, posts no PR
comments and does not use `pull_request_target`. Keep the workflow and base
branch under normal repository review protections: a changed workflow itself
can change job behavior. A PR introducing the reporter gets an explicit
unavailable notice until the trusted base contains the reviewed implementation.

The base configuration selects up to four source roots and entrypoints:

```json
{
  "schemaVersion": 1,
  "targets": [
    { "root": ".", "entry": "bin/audit.js", "allowRootOnly": true }
  ]
}
```

Changes to this configuration take effect only after they reach the base
branch. The initial targets are Package Xray's CLI and the Compose CLI. If a
target lacks a committed npm lockfile and `allowRootOnly` is true, the reporter
creates an isolated root-identity-only lockfile. It reports the
`root-only-source` gap: dependencies have **not** been inventoried, downloaded or
verified. Any unresolved imports still produce gaps. A present but invalid
lockfile is never replaced. Set `allowRootOnly` to false when a real lockfile
and checked-in dependency source snapshot are required.

Each temporary snapshot contains JavaScript and JSON files only, with a
4,096-entry, 16 MiB total and 2 MiB per-file preparation limit. Links and special
files are omitted with an explicit gap. Each scan retains the analyzer's own
smaller source budgets, a 30-second deadline and a 256 MiB worker heap limit.
Use stable checkouts; this is not filesystem isolation against concurrent
hostile writers. Missing sources, unsupported semantics, limits and worker
failures remain explicit coverage gaps and block the decision.
Summary sections and JSON evidence are capped and disclose truncation.

To reproduce with trusted scanner code and stable base/head checkouts:

```sh
node /trusted/pkgxray/scripts/compose-pr-report.js \
  --base /snapshots/base --head /snapshots/head \
  --base-sha "$BASE_SHA" --head-sha "$HEAD_SHA" \
  --output /tmp/new-compose-pr-report
```

Use the matching full Git commit IDs. The CLI labels the report with the supplied
IDs; CI obtains them from the pull-request event and checks out those exact
commits. The output must be outside both inputs and must not already contain
`report.json` or `summary.md`. Inputs remain unchanged.
