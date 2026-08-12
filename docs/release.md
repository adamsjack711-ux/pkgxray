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
   node --test
   node ./benchmark/run.js
   npm run test:docs
   npm run validate:website
   npm pack --dry-run
   ```

4. Confirm the benchmark shows zero false blocks, zero full misses, and no drop
   in recall.
5. Look through `npm pack --dry-run` for files you did not expect, secrets,
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

## Supported releases

Security fixes go to the latest released `1.x` version on `main`. Upgrade before
you report a vulnerability. See [SECURITY.md](../SECURITY.md) for private
reporting and scope.
