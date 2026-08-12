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

You can expect a first reply within a few days. Once a fix ships, we publish the
advisory and credit the reporter, unless you would rather stay anonymous.

## Scope

Normal `guard`, `audit`, and evidence scans run locally and have no
dependencies. They do not execute audited package code, run lifecycle scripts,
or perform `npm install`.

Two surfaces do execute child code, and both are opt-in:

- `pkgxray canary --yes-run-untrusted-code` runs lifecycle scripts inside the
  documented OS sandbox. Use it only on a host you can throw away.
- `pkgxray mcp` (after its package-scan-first gate) and `pkgxray mcp-proxy`
  spawn the configured MCP server to inspect or proxy its protocol.

Their threat models and any containment failure are in security scope. Reports
we especially want:

- sandbox or quarantine escapes that let audited package code execute,
- path-traversal or symlink issues during tarball extraction or staging,
- the self-hostable cache server leaking tokens or serving poisoned content.
  Note its documented trust model: it is a caching proxy, **not** an auth
  boundary. See the README.
- ways to make the static auditor return `safe` or `allow` for genuinely
  malicious evidence (false-negative bypasses).

## Incorrect verdicts

Use the public **Incorrect verdict** issue form for a false positive on benign
code that you can reproduce. Do not publicly attach credentials, private source,
active malware, or a working scanner bypass.

Report a suspected false negative or bypass privately in any of these cases: the
package may be live malware, the reproduction shows how to evade detection, or
disclosure would help an attacker tune around the scanner. The maintainers can
cut a private sample down into a safe regression fixture before any details go
public.

You can dispute a published calibration number in a public issue, as long as the
issue holds no per-package verdicts and no sensitive samples. Include the run
URL, the exact statement you dispute, and calculations someone else can repeat.
