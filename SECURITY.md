# Security Policy

## Supported versions

`pkgxray` is in the `1.x` release line. Security fixes are applied to the latest
released version on the `main` branch. Please upgrade to the newest version
before reporting an issue.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through either channel:

- GitHub's [private vulnerability reporting](https://github.com/adamsjack711-ux/pkgxray/security/advisories/new)
  (Security → Report a vulnerability), or
- Email **adamsjack711@gmail.com** with a description and reproduction steps.

Please include:

- the affected version (`pkgxray --version` or the npm version),
- a minimal reproduction or proof of concept,
- the impact you believe it has.

You can expect an initial acknowledgement within a few days. Once a fix is
released, the advisory will be published with credit to the reporter unless
you prefer to remain anonymous.

## Scope

Normal `guard`, `audit`, and evidence scans run locally, are zero-dependency,
and do not execute audited package code, run lifecycle scripts, or perform
`npm install`.

Two explicitly opt-in surfaces do execute child code:

- `pkgxray canary --yes-run-untrusted-code` runs lifecycle scripts inside the
  documented OS sandbox and should be used only on a disposable host.
- `pkgxray mcp` (after its package-scan-first gate) and `pkgxray mcp-proxy`
  spawn the configured MCP server to inspect or proxy its protocol.

Their threat models and containment failures are in security scope.
Security reports of particular interest include:

- sandbox/quarantine escapes that let audited package code execute,
- path-traversal or symlink issues during tarball extraction or staging,
- the self-hostable cache server leaking tokens or serving poisoned content
  (note its documented trust model: it is a caching proxy, **not** an auth
  boundary — see the README),
- ways to make the static auditor return `safe`/`allow` for genuinely
  malicious evidence (false-negative bypasses).

## Incorrect verdicts

A reproducible false positive on benign code may use the public
**Incorrect verdict** issue form. Do not publicly attach credentials, private
source, active malware, or a working scanner bypass.

Report a suspected false negative or bypass privately when the package may be
live malware, when the reproduction demonstrates evasion, or when disclosure
would help an attacker tune around detection. The maintainers can reduce a
private sample into a safe regression fixture before publishing details.

Disputes about published aggregate calibration numbers may use a public issue
when they contain no per-package verdicts or sensitive samples. Include the run
URL, the exact disputed statement, and reproducible calculations.
