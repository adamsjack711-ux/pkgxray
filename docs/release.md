# Release and verification policy

pkgxray follows [semantic versioning and the 1.x compatibility contract](compatibility.md).
Only maintainers publish releases. A pull request, tag, or passing test run is
not itself a release.

## Version selection

- Patch: bug fixes, docs, calibration changes, and better detection, all on a
  stable interface that has not changed.
- Minor: new commands, flags, JSON fields, or supported surfaces.
- Major: a stable CLI, config, JSON, exit-code, or MCP contract that is removed
  or changed in a way that breaks callers.

A patch release can move a package from `SAFE` to `REVIEW` or `BLOCK`, when
detection starts to recognize new evidence. Any such change needs regression
fixtures, a benchmark review, and release notes.

## Maintainer checklist

1. Review the complete release diff and update `CHANGELOG.md`.
2. Confirm `package.json` and any registry metadata use the intended version.
3. Run:

   ```bash
   npm test
   node ./benchmark/run.js
   npm run test:docs
   npm run validate:website
   npm pack --dry-run --ignore-scripts
   ```

4. Confirm the benchmark shows zero false blocks, zero full misses, and no drop
   in recall.
5. Look through `npm pack --dry-run --ignore-scripts` for files you did not expect, secrets,
   fixtures, or missing docs.
6. Run the release workflow in dry-run mode, and read the result of its
   self-guard on the packed artifact.
7. Create a release tag that is signed and reviewed. Publish only through the
   protected release workflow.
8. Check the npm package version, the provenance attestation, the registry
   signature, the CLI `--version`, and a fresh `npx` scan of a safe package.
9. If the release includes MCP registry metadata, work through its own checklist
   after you publish to npm. That checklist covers ownership, authentication,
   publication, and the registry API.

Never ship a release by working around failing tests, benchmark gates,
provenance, or review of a protected environment.


## Release privilege and artifact boundaries

The `validate` job has read-only repository access and no npm credentials or
OIDC permission. It runs tests and both adversarial baseline gates, packs with
`--ignore-scripts`, checks the archive, and records its SHA-256. The separate
`publish` job has no checkout and executes no package scripts. It downloads the
archive from the same workflow run, verifies that digest, and publishes that
exact tarball with `--ignore-scripts --provenance`. Post-publish artifact checks
run in a separate job without publishing credentials. Release-related PRs and
dry runs also download the uploaded archive in `verify-transfer` and compare
its SHA-256 before the publish job can run.

GitHub actions are pinned to commit IDs. Artifact transfer uses the immutable
[GitHub artifact mechanism](https://github.com/actions/upload-artifact), and
[npm accepts a tarball directly](https://docs.npmjs.com/cli/commands/npm-publish/).
The existing `NPM_TOKEN` is retained only on the publish step; configuring npm
trusted publishing and removing the stored token remains an account-level task.
Protect release refs and workflow changes: job isolation cannot make a malicious
maintainer-approved archive safe. `scripts/verify-release.js` requires a completed
clean OSV check and permits only the deliberately disabled source scan of the
scanner itself. An advisory outage or any other medium/high review finding
fails validation. The post-publish check is mandatory and compares downloaded
archive bytes with the validated SHA-256. Neither check cryptographically
verifies provenance or establishes npm/GitHub source parity; those remain
separate maintainer checks. Dry-run mode validates, uploads and verifies artifact
transfer without publishing. Pull-request events cannot enter the publish job.

## Supported releases

Security fixes go to the latest released `1.x` version on `main`. Upgrade before
you report a vulnerability. See [SECURITY.md](../SECURITY.md) for private
reporting and scope.
