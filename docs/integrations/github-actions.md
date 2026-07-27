# GitHub Actions

The lowest-maintenance integration is to run a version-pinned pkgxray release
directly with `npx`. It needs no secret and no write permission. A reusable
workflow is also available for teams that prefer central configuration.

## Pull-request gate

This example fails on `BLOCK`, reports `REVIEW` as a warning, and permits
`SAFE`. Change `TARGET` to any supported manifest listed below.

```yaml
name: pkgxray

on:
  pull_request:
    paths:
      - "**/package-lock.json"
      - "**/npm-shrinkwrap.json"
      - "**/pnpm-lock.yaml"
      - "**/pnpm-lock.yml"
      - "**/yarn.lock"
      - "**/package.json"

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          persist-credentials: false

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: "20"

      - name: Scan dependency manifest
        env:
          PKGXRAY_VERSION: "1.0.5"
          TARGET: package-lock.json
        run: |
          set +e
          npx --yes "pkgxray@${PKGXRAY_VERSION}" audit "${TARGET}" --format json
          rc=$?
          set -e
          case "${rc}" in
            0) echo "pkgxray: SAFE" ;;
            2) echo "::error::pkgxray: BLOCK"; exit 1 ;;
            3) echo "::warning::pkgxray: REVIEW" ;;
            *) echo "::error::pkgxray failed (exit ${rc})"; exit 1 ;;
          esac
```

Keep both the action SHAs and `PKGXRAY_VERSION` current through reviewed
Dependabot pull requests. Do not replace them with mutable `@main`, `@v4`, or
`pkgxray@latest` references in a security gate.

## Supported targets

| What to scan | Command |
|---|---|
| npm lockfile | `npx --yes pkgxray@1.0.5 audit package-lock.json` |
| npm shrinkwrap | `npx --yes pkgxray@1.0.5 audit npm-shrinkwrap.json` |
| pnpm lockfile | `npx --yes pkgxray@1.0.5 audit pnpm-lock.yaml` |
| Yarn lockfile | `npx --yes pkgxray@1.0.5 audit yarn.lock` |
| package manifest | `npx --yes pkgxray@1.0.5 audit package.json` |
| one exact npm package | `npx --yes pkgxray@1.0.5 guard npm:express@4.21.0` |

Prefer a lockfile when one exists: it contains resolved versions. A
`package.json` range cannot prove which version is installed, so incomplete
resolution may produce `REVIEW`.

Every command accepts `--format json`. pkgxray does not currently emit SARIF;
do not upload its JSON as SARIF. The stable JSON contract is documented in
[the JSON schema](../json-schema.md).

## Scheduled rechecks

`recheck` compares the current result with the sibling `.pkgxray.lock`
baseline. A regression exits nonzero; a merely available newer version is
informational.

```yaml
name: pkgxray scheduled recheck

on:
  schedule:
    - cron: "17 5 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  recheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: "20"
      - run: npx --yes pkgxray@1.0.5 recheck package-lock.json --format json
```

## Reusable workflow

This repository includes
[`pkgxray-audit.yml`](../../.github/workflows/pkgxray-audit.yml). Pin a reviewed
commit SHA when calling it:

```yaml
permissions:
  contents: read

jobs:
  pkgxray:
    uses: adamsjack711-ux/pkgxray/.github/workflows/pkgxray-audit.yml@<PINNED_COMMIT_SHA>
    with:
      fail-on: block
      pkgxray-version: "1.0.5"
      output-format: json
```

Optional inputs:

- `lockfile`: scan one named manifest instead of auto-detecting lockfiles.
- `package`: guard one exact `name@version` npm package instead of a manifest.
- `fail-on`: `block` (default) or `review`.
- `output-format`: `markdown` (default) or `json`.

Set only one of `lockfile` and `package`.

## Verdicts and security assumptions

- `SAFE` / exit `0`: no high- or medium-risk indicators were found.
- `REVIEW` / exit `3`: human review is required; choose whether this fails CI.
- `BLOCK` / exit `2`: reject the dependency or investigate the cited evidence.
- Any other exit means pkgxray failed; the examples fail closed.

Ordinary scans require no secret. They do make outbound requests to npm, OSV,
and, unless disabled, GitHub metadata endpoints. GitHub-hosted runners receive
untrusted package data, so keep permissions read-only and checkout credentials
disabled. Static analysis is defense in depth, not proof that a package is
harmless; see the [threat model](../threat-model.md).
