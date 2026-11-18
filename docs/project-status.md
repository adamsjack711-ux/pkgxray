# Project status

pkgxray is an actively maintained `1.x` project. Its stable CLI, exit codes,
JSON schema, configuration, and MCP contracts follow the
[compatibility policy](compatibility.md). Detection results may get stricter as
signatures and vulnerability data improve. That is expected, and the calibration
corpus gates it against regressions.

## Published release and candidate

As checked on 2026-11-17, npm's latest release is **1.2.1**. This branch prepares
**1.3.0**, which is not yet published. Use the [candidate testing guide](testing-1.3.md)
to exercise its packed CLI and local MCP without relying on an unpublished npm
version. The website and public MCP endpoint are separate deployments.

The 1.3 candidate adds bundled Compose analysis, advisory review plans, fresh
upgrade comparisons and opt-in session credential-transfer checks. These are
not the later automatic-decision / 2.0 prototypes. Release readiness work and
verification are recorded in the repository's [STATUS.md](../STATUS.md).

The candidate preserves explicit `allow-review` for ordinary review findings.
`safe-only` keeps those findings held until an eligible, action-specific Proceed;
neither mechanism clears incomplete mandatory checks. Source collection now
distinguishes parsed imports from diagnostic strings. Computed module targets
and unsupported runtime syntax still require operator investigation, even in
familiar packages. See the [package trial](1.3-package-trial.md) for the frozen
inputs, measured outcomes and remaining usability limits.

The final local 11-package cohort returned three allow and eight review results;
six reviews retained mandatory coverage holds. Large packages still reach file
and analysis limits, and a separate controlled Zod worker run still timed out.
Completing that cohort does not establish reliable latency or external tester
acceptance.

## Supported core surfaces

- Pre-install `guard` scans for npm packages, GitHub references, and local
  directories.
- Dependency audits for npm, pnpm, and Yarn manifests.
- Baseline-based `recheck` monitoring.
- The local stdio MCP server, connect-time MCP manifest audit, and stdio runtime
  proxy.
- A Node.js 18+ runtime with no dependencies. Historical CI covers the supported
  floor, LTS lines and current Node; that is not a fresh check of this candidate.
- npm releases with provenance, tests, benchmark gates, and a self-audit.

Use a maintained Node.js release for production and CI. Node 18 still sits within
the published compatibility floor, but it is end-of-life upstream. Dropping it
would be a deliberate compatibility change, not a silent patch update.
The current local candidate checks ran on macOS ARM64 with Node 26.0.0; the
release matrix must run again against the integrated revision.

## Experimental or opt-in

- The Hookshot package-install gate is Experimental, because it depends on an
  external agent-hook ABI and on cautious command parsing.
- The browser extension is load-unpacked only and is not published to a store.
- `pkgxray canary` is opt-in and executes untrusted lifecycle scripts inside an
  OS sandbox. It confirms observed malice but never clears a package.
- Compose is experimental and bundled in the 1.3 candidate. It scans selected
  local JavaScript sources without executing them and never approves installation.
- Local VM scans are experimental, explicitly enabled execution in the 1.3
  candidate. Trusted boot assets must be built separately. The VM runbook records
  actual macOS ARM64 guest checks; Linux/Windows guest checks remain outstanding.
  No VM execution is exposed by the public MCP endpoint or website.

## Current priorities

1. Complete validation of the final candidate archive and retain the mandatory
   scan and receipt checks across every approval consumer.
2. Gather independent tester feedback on setup, review noise, coverage gaps and
   actionable evidence; the local convenience cohort is not user acceptance.
3. Improve large-package worker reliability and remaining computed-target and
   behavioral coverage within bounded analysis, without turning incomplete
   scans into approvals.
4. Coordinate npm, MCP registry metadata and
   deployment updates before advertising 1.3 as published.

These priorities show direction. They are not promised release dates. Public
proposals and status changes belong in focused issues and pull requests. Work
that touches security follows [SECURITY.md](../SECURITY.md).
