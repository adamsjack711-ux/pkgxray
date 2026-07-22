# Project status

pkgxray is an actively maintained `1.x` project. Its stable CLI, exit codes,
JSON schema, configuration, and MCP contracts follow the
[compatibility policy](compatibility.md). Detection results may become stricter
as signatures and vulnerability data improve; that is expected behavior and is
regression-gated against the calibration corpus.

## Supported today

- Pre-install `guard` scans for npm packages, GitHub references, and local
  directories.
- Dependency audits for npm, pnpm, and Yarn manifests.
- Baseline-based `recheck` monitoring.
- The local stdio MCP server, connect-time MCP manifest audit, and stdio runtime
  proxy.
- Zero-dependency Node.js 18+ runtime, tested across the supported floor, active
  LTS lines, and current Node.
- npm releases with provenance, tests, benchmark gates, and self-audit.

Use a maintained Node.js release for production and CI. Node 18 remains within
the published compatibility floor, but it is end-of-life upstream; dropping it
would be a deliberate compatibility change rather than a silent patch update.

## Experimental or opt-in

- The Hookshot package-install gate is Experimental because it depends on an
  external agent-hook ABI and conservative command parsing.
- The browser extension is load-unpacked only and is not published to a store.
- `pkgxray canary` is opt-in and executes untrusted lifecycle scripts inside an
  OS sandbox. It confirms observed malice but never clears a package.

## Current priorities

1. Harden the MCP server's operator-controlled filesystem boundary and prepare
   metadata for official registry review.
2. Verify coding-agent setup guides against current product configuration
   formats without claiming automatic enforcement.
3. Expand benign and malicious calibration fixtures from responsibly disclosed
   real-world cases.
4. Improve website keyboard, mobile, and reduced-motion behavior.

These priorities are directional, not promised release dates. Public proposals
and status changes belong in focused issues and pull requests. Security-sensitive
work follows [SECURITY.md](../SECURITY.md).
