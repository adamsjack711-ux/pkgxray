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
   Pack the candidate and exercise its installed entrypoints outside the checkout:

   ```bash
   mkdir -p .pack
   COPYFILE_DISABLE=1 npm pack --ignore-scripts --pack-destination .pack
   candidate_unpack_dir="$(mktemp -d)"
   tar -xzf .pack/pkgxray-1.3.0.tgz -C "$candidate_unpack_dir"
   node scripts/check-packed-runtime.js "$candidate_unpack_dir/package"
   ```

   This checks the packed CLI version, an inert Compose scan, both MCP launchers,
   tool discovery, and inert SAFE/BLOCK evidence. It does not install or execute
   the inspected fixture. Use the current package version in the archive name.
   Always extract into a new directory so files removed from the archive cannot
   survive from a previous check and conceal a packaging regression.
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
The verifier also rejects a GitHub release tag that differs from the package
version and an MCP npm descriptor pointing at another package version. Lint and
the packed-runtime smoke check run in the unprivileged validation job.

## Coordinate the publication surfaces

The checkout version, published npm version and deployed service revision can
differ while preparing a release. A version bump is not evidence of publication.

1. Finish the candidate checks, record its source/build identity and archive
   SHA-256, and review the complete diff. Keep the changelog entry unreleased
   until publication and retain the existing published installation command.
2. Publish the reviewed archive through the release workflow. Verify downloaded
   bytes, npm version/provenance and a fresh installed-package scan before
   advancing installation examples.
3. Publish the matching MCP Registry descriptor using
   [its publication checklist](mcp-registry.md). A remote URL in that descriptor
   does not deploy or upgrade the hosted Worker.
4. Update the README/reference and website's **published CLI** command to the
   verified npm version, together with the tests that pin those commands. Keep
   recorded scan receipts, dates and scanner versions unchanged. Run docs and
   website checks, then synchronize the website deploy mirror from this repo
   as described in [website/README.md](../website/README.md).
5. In `services/public-mcp/package.json`, advance `publishedCliVersion` only
   after npm verification. The service's own `version` must match the root
   scanner version; its build generates the protocol/health version from that
   identity and keeps the suggested npm install version separate. Run the
   service unit, local HTTP integration and dry-run build checks before any
   deployment. After deployment, verify `/health`, MCP initialization and the
   existing live smoke checks, recording the actual deployed revision.

Each publish/deploy step is a separate external action. Preparation and passing
local checks do not establish that npm, the Registry, the website or the hosted
MCP endpoint has changed. Record pending surfaces in the release handoff.

## Supported releases

Security fixes go to the latest released `1.x` version on `main`. Upgrade before
you report a vulnerability. See [SECURITY.md](../SECURITY.md) for private
reporting and scope.
