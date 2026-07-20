# Contributing to pkgxray

Thanks for helping improve pkgxray — pre-install security for npm packages,
MCP servers, and AI agents.

## Before opening an issue

- Use the **Bug report** form for reproducible runtime or CLI failures.
- Use **Incorrect verdict** only when the evidence is benign and safe to share.
- Report suspected false negatives, live malware, credentials, private source,
  and working scanner bypasses through
  [private vulnerability reporting](https://github.com/adamsjack711-ux/pkgxray/security/advisories/new).
- For a calibration dispute, identify the published run, exact statement, and
  reproducible calculation. Do not publish per-package verdicts or sensitive
  samples.

See [SECURITY.md](SECURITY.md) for the complete disclosure boundary.

## Development

Requirements:

- Node.js 18 or newer; maintained Node releases are recommended.
- No runtime dependency installation is required.

```bash
git clone https://github.com/adamsjack711-ux/pkgxray.git
cd pkgxray
node --test
node ./benchmark/run.js
npm run test:docs
npm run validate:website
```

Run only the checks relevant to documentation-only changes while iterating,
then run the full suite before requesting review.

## Detection and verdict changes

Detection changes need evidence, not only a new pattern:

1. Reduce malicious behavior to the smallest inert source fixture.
2. Add a benign near-neighbor that must not block.
3. Add both to the benchmark corpus with an explanation.
4. Run `node --test` and `node ./benchmark/run.js`.
5. State whether any existing input changes between `SAFE`, `REVIEW`, and
   `BLOCK`.

Never commit active malware, credentials, weaponized payloads, or private
source. Preserve the documented calibration scope: zero heuristic false blocks
applies to the published top-1,000 run, not every npm or MCP package.

## Code and documentation style

- Keep runtime code zero-dependency unless there is a compelling, reviewed
  security reason to change that constraint.
- Prefer Node built-ins and deterministic behavior in the verdict path.
- Keep output evidence citable and attacker-controlled terminal text sanitized.
- Document network, filesystem, process-execution, and permission effects.
- Pin third-party GitHub Actions to full commit SHAs with version comments.
- Use accurate terms: malicious, vulnerable, flagged, and high-risk are not
  interchangeable.

## Pull requests

Keep pull requests focused. Include:

- the problem and design decision,
- files and public contracts changed,
- tests and exact results,
- security/compatibility impact,
- documentation and manual steps,
- screenshots for visible website changes,
- unresolved risks.

Detection and compatibility changes may require a changelog entry. Publishing,
deploying, and registry submission are maintainer-only actions performed from
reviewed release commits.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
