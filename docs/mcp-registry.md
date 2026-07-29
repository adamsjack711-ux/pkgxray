# MCP Registry

Status: pkgxray's MCP metadata and runtime entry point ship in the released
`pkgxray@1.0.5` (`mcpName` marker + the `mcp-server` launcher). The entry
`io.github.adamsjack711-ux/pkgxray` is **currently listed** (v1.0.5,
re-published 2026-07-29). The Registry is still in
**preview and periodically resets its data**, so a live lookup may occasionally
return nothing, in which case the entry must be **re-submitted**
(`mcp-publisher publish` — see "Manual Registry publication" below). Local and
`npx`-based setup does not depend on the Registry.

## Prepared metadata

- Registry name: `io.github.adamsjack711-ux/pkgxray`
- npm package: `pkgxray`
- transport: local stdio
- launch contract: `pkgxray mcp-server`
- metadata: [`server.json`](../server.json)
- npm ownership marker: `package.json#mcpName`

`server.json`, `package.json`, and the npm artifact must all use the same exact
release version. Published `pkgxray@1.0.5` already carries `mcpName` and the
`mcp-server` launcher, so the registry entry can be submitted from that release;
keep the three versions in lockstep on every future bump.

## Pre-release verification

1. Choose the next release version without changing it only for registry
   submission.
2. Update `package.json`, `server.json.version`, and
   `server.json.packages[0].version` together.
3. Run the complete [release checklist](release.md).
4. Inspect `npm pack --dry-run`; confirm `server.json`, `bin/mcp-server.js`, and
   the `pkgxray` launcher are included.
5. Exercise both launch paths against the packed artifact:

   ```bash
   pkgxray-mcp
   pkgxray mcp-server
   ```

6. Send `initialize`, `tools/list`, and one inert evidence audit over stdio.
   Confirm the reported server version matches the package.
7. Confirm every advertised tool has a title, description, input schema, and
   read/destructive/idempotent/open-world annotations.
8. Verify a lockfile inside `PKGXRAY_MCP_ALLOWED_ROOTS` succeeds, a path outside
   it fails, and a symlink cannot escape it.

## Package ownership verification

Publish the reviewed npm package with provenance first. Then verify:

```bash
npm view pkgxray@<VERSION> version mcpName --json
npx --yes --package pkgxray@<VERSION> pkgxray --version
```

The returned `mcpName` must be exactly
`io.github.adamsjack711-ux/pkgxray`. Publishing npm requires the maintainer's
npm account, protected release environment approval, and configured npm trusted
publishing/provenance. None of those credentials belong in `server.json`.

## Manual Registry publication

The maintainer needs:

- a GitHub account that controls the `adamsjack711-ux` namespace;
- browser access for GitHub device authorization;
- a local installation of the official `mcp-publisher` CLI;
- the already-published npm release described above.

Using a reviewed checkout of the release tag:

```bash
brew install mcp-publisher
mcp-publisher --help
mcp-publisher login github
mcp-publisher publish
```

`login github` displays a one-time device code and asks the maintainer to
authorize it at `https://github.com/login/device`. Do not paste that code or the
saved Registry token into issues, CI logs, or source control.

Publication is a manual external write. It must be performed only after review;
this repository does not automate it.

## Post-publication verification

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.adamsjack711-ux/pkgxray"
```

Confirm:

- the returned name and version match the release;
- the npm identifier and exact version are correct;
- the repository ID is `1276320499`;
- installation launches `pkgxray mcp-server`, not the audit CLI;
- a fresh client can initialize, list all intended tools, and remove the server
  without leaving a global package installation.

If package validation fails, first inspect the published npm artifact's
`mcpName`. If namespace authorization fails, repeat
`mcp-publisher login github` with the GitHub account that owns the namespace.
