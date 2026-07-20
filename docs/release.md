# Release and verification policy

pkgxray follows [semantic versioning and the 1.x compatibility contract](compatibility.md).
Only maintainers publish releases. A pull request, tag, or passing test run is
not itself a release.

## Version selection

- Patch: bug fixes, documentation, calibration changes, and improved detection
  on an unchanged stable interface.
- Minor: additive commands, flags, JSON fields, or supported surfaces.
- Major: removal or incompatible change to a stable CLI, configuration, JSON,
  exit-code, or MCP contract.

Detection may change a package from `SAFE` to `REVIEW` or `BLOCK` in a patch
release when new evidence is recognized. Such changes require regression
fixtures, benchmark review, and release notes.

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

4. Confirm the benchmark has zero false blocks, zero full misses, and no recall
   regression.
5. Inspect `npm pack --dry-run` for unexpected files, secrets, fixtures, or
   missing documentation.
6. Run the release workflow in dry-run mode and review its packed-artifact
   self-guard result.
7. Create a signed/reviewed release tag and publish only through the protected
   release workflow.
8. Verify the npm package version, provenance attestation, registry signature,
   CLI `--version`, and a fresh `npx` safe-package scan.
9. If MCP registry metadata is part of the release, follow its separate
   ownership, authentication, publication, and registry-API checklist after npm
   publication.

Never bypass failing tests, benchmark gates, provenance, or protected
environment review to ship a release.

## Supported releases

Security fixes are applied to the latest released `1.x` version on `main`.
Users should upgrade before reporting a vulnerability. See
[SECURITY.md](../SECURITY.md) for private reporting and scope.
