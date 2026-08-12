# Calibration stats: how this page is published

This is the public policy for the `/stats` calibration page. The step-by-step
operational runbook (and any embargoed-disclosure tracking) is kept off the
public site, on the air-gapped scan side.

## Two stages, never merged

- **Stage 1, aggregate calibration.** Four numbers, no package names, no
  per-package verdicts. That is this page.
- **Stage 2, a named vulnerability disclosure.** Ships as its own page and its
  own announcement, on its own disclosure clock. It is never bundled into a
  calibration update.

## Aggregate only

The page publishes exactly four numbers: packages scanned, false blocks on the
top-1000, known-malware catch rate, and run date with pkgxray version. No
per-signal breakdowns, no verdict-distribution tables, and **no per-package
verdicts**. A public "package to verdict" lookup would let an attacker publish a
probe, check the page, and tune against the scanner. Aggregates support the
claim without handing over that signal.

## Reproducible

Every published number is backed by the methodology page and by committed input
lists under
[`validation/`](https://github.com/adamsjack711-ux/pkgxray/tree/main/validation).

## Static, generated, air-gapped

The site never queries the scan data live. A run is built like this:

1. On the scan side, a script produces a leak-checked aggregate artifact.
2. A person reviews it and copies it by hand into `stats/data/<date>.json`.
   That copy is the entire publish decision. No cron job or network route is
   wired between the scan store and the site.
3. `node stats/build.mjs` renders frozen, versioned pages with the numbers baked
   in, and publishes the artifact alongside each page.

## Versioned and unchanging

Each run lives at a stable URL, `/stats/<date>`, and stays up. `/stats` shows the
latest. Published runs never change: a corrected number is published as a new
dated run and noted in the "Corrections" section, not edited in place. Contest a
figure via
[GitHub issues](https://github.com/adamsjack711-ux/pkgxray/issues) (label
`calibration`).

## Disclosure policy: when a finding is "big"

Most findings just move the numbers. Any of these goes to private disclosure
instead of a silent stat update:

- a **confirmed malicious** package with meaningful download volume;
- **three or more related** packages flagged in one run (a campaign);
- a **typosquat** of a top-1000 package;
- **any confirmed finding in an MCP server** package.

Order of notification, always:

1. **Maintainer, privately**, on the standard disclosure clock, via repo
   `SECURITY.md` → `security.txt` → GitHub private vulnerability reporting →
   maintainer email. Never a public issue.
2. **npm registry security, in parallel**, but only if the package is confirmed
   *malicious* rather than merely vulnerable. They can unpublish, which is the
   fastest protection for users.
3. **Public, last**, after the window closes: a GitHub Security Advisory, and a
   CVE if warranted.

**One exception:** a package confirmed malicious *and actively being installed*.
The 90-day norm gives maintainers a fix window; it does not exist to protect an
attacker's dwell time. Report to npm immediately and warn publicly the same day
if needed.
