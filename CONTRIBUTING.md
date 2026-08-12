# Contributing to pkgxray

Thanks for helping improve pkgxray, pre-install security for npm packages, MCP
servers, and AI agents.

## Before opening an issue

- Use the **Bug report** form for reproducible runtime or CLI failures.
- Use **Incorrect verdict** only when the evidence is benign and safe to share.
- Report suspected false negatives, live malware, credentials, private source,
  and working scanner bypasses through
  [private vulnerability reporting](https://github.com/adamsjack711-ux/pkgxray/security/advisories/new).
- To dispute a calibration number, name the published run and the exact
  statement, and show a calculation someone else can repeat. Do not publish
  per-package verdicts or sensitive samples.

See [SECURITY.md](SECURITY.md) for the full disclosure boundary.

## Development

Requirements:

- Node.js 18 or newer. Use a maintained Node release if you can.
- You do not need to install any runtime dependency.

```bash
git clone https://github.com/adamsjack711-ux/pkgxray.git
cd pkgxray
node --test
node ./benchmark/run.js
npm run test:docs
npm run validate:website
```

While you iterate on a documentation-only change, run just the checks that apply
to it. Run the full suite before you ask for review.

## Detection and verdict changes

A detection change needs evidence, not just a new pattern:

1. Reduce malicious behavior to the smallest inert source fixture.
2. Add a benign near-neighbor that must not block.
3. Add both to the benchmark corpus with an explanation.
4. Run `node --test` and `node ./benchmark/run.js`.
5. State whether any existing input changes between `SAFE`, `REVIEW`, and
   `BLOCK`.

Never commit active malware, credentials, weaponized payloads, or private source.
Keep the documented calibration scope intact: zero heuristic false blocks applies
to the published top-1,000 run, not to every npm or MCP package.

## Code and documentation style

- Keep runtime code free of dependencies, unless there is a strong security
  reason to change that and a reviewer agrees.
- Prefer Node built-ins, and keep the verdict path deterministic.
- Keep output evidence citable, and sanitize terminal text an attacker controls.
- Document any effect on the network, the filesystem, process execution, or
  permissions.
- Pin third-party GitHub Actions to full commit SHAs, with version comments.
- Use terms accurately. Malicious, vulnerable, flagged, and high-risk do not mean
  the same thing.

## Pull requests

Keep pull requests focused. Include:

- the problem and design decision,
- files and public contracts changed,
- tests and exact results,
- security/compatibility impact,
- documentation and manual steps,
- screenshots for visible website changes,
- unresolved risks.

A detection or compatibility change may need a changelog entry. Publishing,
deploying, and registry submission are maintainer-only actions, and they run from
reviewed release commits.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
