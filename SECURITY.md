# Security Policy

## Supported versions

`pkgxray` is in the `0.x` series. Security fixes are applied to the latest
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

`pkgxray` runs entirely locally and is zero-dependency. It does not execute
audited package code, run lifecycle scripts, or perform `npm install`.
Security reports of particular interest include:

- sandbox/quarantine escapes that let audited package code execute,
- path-traversal or symlink issues during tarball extraction or staging,
- the self-hostable cache server leaking tokens or serving poisoned content
  (note its documented trust model: it is a caching proxy, **not** an auth
  boundary — see the README),
- ways to make the static auditor return `safe`/`allow` for genuinely
  malicious evidence (false-negative bypasses).
