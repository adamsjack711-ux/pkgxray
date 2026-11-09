# pkgxray integration contract · v1

## Run it

```sh
node bin/compose-ray.mjs /path/to/source-tree --entry index.js \
  --pkgxray /path/to/trusted/pkgxray --json
```

The scanner path identifies code you trust to run, not a package being inspected.
The adapter uses pkgxray's CommonJS `auditEvidence` export and `BUILD_ID`, with
evidence reports at `schemaVersion: 1`. Compatibility CI pins upstream commit
`1b48ce81767acfa032fa2e7a2b37ec00cc4048f3`. Other builds require the same API;
a passing protocol stub test is not evidence of real-engine compatibility.

## Input and source binding

- npm lockfile v2/v3 and local sources at matching locked paths.
- One relative CommonJS entrypoint, defaulting to `index.js`.
- Each instance receives its own selected manifest/source files. The root ID is
  `.`; dependencies retain their full nested `node_modules` paths.
- Before pkgxray receives the bytes, the adapter checks the lockfile hash, file
  ownership, and selected file SHA-256 hashes against Compose-ray's report.
- Each input explicitly has `sourceCoverage.complete: false`: unselected files
  and other entrypoints have not been inventoried.
- Since 0.3.1, bounded ESM entry bytes are retained for static package checks.
  Compose-ray still reports an unsupported-format gap and does not follow ESM imports.

Use a stable snapshot. These checks detect ordinary between-scan changes; they
are not a filesystem sandbox against a concurrent hostile writer. Local hashes
do not authenticate registry archives. Lockfile integrity remains unverified.

## Combined JSON

Flow-only JSON stays unchanged. Combined mode adds this envelope (nested reports
and limitations abbreviated here):

```json
{
  "schemaVersion": 1,
  "tool": "package-compose-ray",
  "mode": "pkgxray-composition",
  "decision": "review",
  "authorization": { "installAllowed": false },
  "summary": "Environment data reaches a network call. Review the route and whether the transfer is intended.",
  "coverage": {
    "status": "partial",
    "flow": "complete-for-supported-entry",
    "packageChecks": "selected-source-files",
    "registryIntegrityVerified": false,
    "vulnerabilityCheck": "not-run",
    "provenanceCheck": "not-run"
  },
  "execution": "completed",
  "blockingPackages": [],
  "gaps": [],
  "limitations": [],
  "compose": {},
  "pkgxray": {}
}
```

`compose` retains the full original flow report: identities, file hashes, lockfile
hash, findings, gaps, and budgets. `pkgxray` contains:

- `engine`: name, version, and build ID, or `null` if unavailable.
- `status`: `completed`, `partial` (some package calls failed), or `failed`.
- `packages`: instance `id`, `status`, and original evidence `report`, or an
  `error` for that instance. Findings are not reduced to a score.

`execution: completed` means the requested analysis calls finished without
reported gaps. `coverage.status` remains `partial`. Original pkgxray scores
describe supplied evidence, not checks the adapter did not run.

Gaps carry `engine`, `code`, and `message`; package failures also carry
`packageId`. Original `compose.gaps` remains available. Readers should tolerate
additive fields but reject unsupported schema versions before using decisions.

## Decision rules

| Evidence | Combined decision | Exit |
| --- | --- | --- |
| Any valid pkgxray package report is `block` | `block`, even if another package fails or flow is clear | `2` |
| Credential flow, pkgxray review, missing engine, unknown behavior, or missing coverage | `review` | `3` |
| No concerning finding in either engine's supplied evidence | `review` because coverage remains partial | `3` |

Invalid CLI arguments exit `2` with a diagnostic and no report. The demo's exit
`0` only means its assertions passed. No clean score or timeout clears the other
engine's evidence. Destination authorization is not modeled; a flow requests
review, not a malware conviction. No install-allow result or receipt is issued.

## Resource and trust boundaries

Compose-ray's [normal budgets](reference.md#explicit-limits) apply. The adapter
uses the same bounded reader. The worker receives at most 32 MiB of encoded input,
captures at most 8 MiB per output stream, and has a maximum 30-second deadline.
Package errors are retained; whole-worker failures preserve Compose-ray's report
and create an integration gap.

Node is invoked directly without a shell, with a minimal environment that does
not inherit `NODE_OPTIONS` or credential variables. The selected scanner remains
trusted executable code. This child process does not confine a malicious scanner.

## Programmatic API

```js
import { analyzeWithPkgxray } from './src/integration.mjs';
const report = analyzeWithPkgxray({
  root: '/path/to/source-tree',
  entry: 'index.js',
  scannerRoot: '/path/to/trusted/pkgxray',
});
```

The API is synchronous. Analysis/worker failures become gaps; invalid API options
throw. This is a local review API, not the future archive-verification interface.
