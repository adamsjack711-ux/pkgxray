# Project status

pkgxray is an actively maintained `1.x` project. Its stable CLI, exit codes,
JSON schema, configuration, and MCP contracts follow the
[compatibility policy](compatibility.md). Detection results may get stricter as
signatures and vulnerability data improve. That is expected, and the calibration
corpus gates it against regressions.

## Supported today

- Pre-install `guard` scans for npm packages, GitHub references, and local
  directories.
- Dependency audits for npm, pnpm, and Yarn manifests.
- Baseline-based `recheck` monitoring.
- The local stdio MCP server, connect-time MCP manifest audit, and stdio runtime
  proxy.
- A Node.js 18+ runtime with no dependencies, tested on the supported floor, the
  active LTS lines, and current Node.
- npm releases with provenance, tests, benchmark gates, and a self-audit.

Use a maintained Node.js release for production and CI. Node 18 still sits within
the published compatibility floor, but it is end-of-life upstream. Dropping it
would be a deliberate compatibility change, not a silent patch update.

## Experimental or opt-in

- The Hookshot package-install gate is Experimental, because it depends on an
  external agent-hook ABI and on cautious command parsing.
- The browser extension is load-unpacked only and is not published to a store.
- `pkgxray canary` is opt-in and executes untrusted lifecycle scripts inside an
  OS sandbox. It confirms observed malice but never clears a package.

## Current priorities

1. Harden the file-path limits that an operator sets on the MCP server, and get
   the metadata ready for review by the official registry.
2. Check the setup guides for coding agents against the config formats those
   products use now, and do not claim that any of it is enforced for you.
3. Add more benign and malicious fixtures to the calibration corpus, drawn from
   real cases that were disclosed responsibly.
4. Make the website work better with a keyboard, on a phone, and for readers who
   ask for less motion.

These priorities show direction. They are not promised release dates. Public
proposals and status changes belong in focused issues and pull requests. Work
that touches security follows [SECURITY.md](../SECURITY.md).
