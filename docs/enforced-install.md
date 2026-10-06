# Install approved archives

`pkgxray install` is an explicit installation command. It scans every package in an npm lockfile, then runs npm against those approved archives. `guard`, `audit`, and the Hookshot integration remain preflight assessments; they do not substitute for this command.

From this checkout:

```bash
node /path/to/pkgxray/bin/audit.js install /path/to/project
# Or, after installing this build:
pkgxray install . --format json
```

The project must already contain consistent `package.json` and npm `package-lock.json` v2/v3 files. Lockfile generation and dependency selection happen separately. The command does not accept npm flags or options to disable inspection. It requires a trusted npm installation beside the running Node executable, system `/usr/bin/tar`, and currently targets POSIX systems (macOS/Linux).

## What the command enforces

1. Validate all locked paths, registry URLs, exact versions and integrity hashes, including transitive dependencies.
2. Download and scan each locked archive. Require a matching ALLOW receipt for its identity, digest, scanner build and policy, with completed source and vulnerability checks. Re-verify archive integrity after scanning.
3. Create a private staging project with lockfile URLs rewritten to the approved local archives. Run `npm ci --offline --ignore-scripts --no-audit --no-fund` using a fresh cache, empty user/global npm configuration and a restricted child environment. The child launches npm beside the current Node installation through that same Node executable; project-local PATH shims are not used. Project `.npmrc`, npm environment overrides and Node preload settings do not reach this child. POSIX archive inspection uses system tar with a restricted environment that excludes `TAR_OPTIONS` and project executable paths. These flags follow npm's documented [ci behavior](https://docs.npmjs.com/cli/v11/commands/npm-ci/).
4. Compare every installed package file against the approved extracted contents. Executable links must stay within the approved tree; executable declarations come from the scanned manifest. Reject unexpected, missing or changed files.
5. Recheck the original manifest, lockfile and on-disk policy before promotion. Preserve the old `node_modules` under the reported `.pkgxray-previous-node_modules-<id>` path, then rename the completed tree into place. Failed scans and failed installs leave the old tree in place; a failed final rename restores it.

Lifecycle scripts stay disabled, including root-project scripts. Packages requiring native compilation or install-time setup may therefore be unusable. Running `npm rebuild` afterward is a separate execution outside this command's protection.

The command preserves the project's manifest and lockfile. It writes `node_modules/.pkgxray-install.json`, containing their hashes, scanner/policy fingerprints, per-package approval records and installed/skipped paths. Platform-incompatible optional dependencies may be skipped by npm; they are still scanned beforehand. Receipts are local unsigned records, not remote attestations or guarantees of harmless behavior.

## Current supported scope

- npm package-lock v2/v3, registry semver dependencies, HTTPS tarballs with SRI hashes; ordinary nested dependencies and executable links.
- The guard's existing registry host checks apply. The default acquisition path resolves metadata through the public npm registry.
- Maximum 1,000 locked package locations, 512 MiB total compressed archives, 512 MiB extracted content and 100,000 extracted entries. Existing per-archive scan/download limits also apply. The npm phase has a five-minute timeout.

Workspaces, aliases, Git/file/link dependencies, shrinkwrap files (including package-local shrinkwrap), bundled dependencies, directory-based bin declarations and dependency overrides are rejected. Yarn, pnpm, PyPI and Windows installation are not yet supported. Failure to represent a dependency safely stops installation rather than switching to a normal networked install.

## Boundaries and recovery

This command controls its own npm invocation. It is **not an OS network sandbox** and does not prevent a user, agent, different package manager or later runtime process from downloading packages directly. CI should invoke this command as its install step; adversarial bypass prevention additionally requires runner/network restrictions outside this repository. Static analysis still cannot prove the absence of concealed or runtime-fetched payloads.

Keep the Node/npm executables, scanner source and project directory under trusted control. The transaction checks detect ordinary concurrent manifest/policy edits; they do not defend against a hostile process with the same filesystem privileges. Replacement uses two renames with rollback, not a filesystem-wide atomic transaction. A process or machine crash between renames can leave the backup present while `node_modules` is absent.

A `.pkgxray-install.lock` directory excludes concurrent invocations. If a process crashes, confirm no installer is running before removing that lock and its abandoned staging directory. Keep the reported backup until the installation has been checked; restore it by moving the new tree aside and renaming the backup to `node_modules`. Backups are never automatically deleted.
