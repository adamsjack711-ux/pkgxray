# Detection and process confinement follow-up — 2026-09-12

For the subsequent local execution-graph fixes, corrected flow summaries and
current validation results, see the [2026-09-23 audit](detection-audit-2026-09-23.md).
The measurements below describe the earlier pass, not the current engine.

This local, uncommitted pass addresses the remaining misses from the previous
security-hardening report. No package was published or repository changes pushed.

## Changes

The flow engine now parses JavaScript with bundled Acorn 8.18.0. A bounded
abstract interpreter tracks environment credentials, fetched source, assignment
order, lexical shadowing, branch joins, simple function arguments, request
objects, templates and literal local CommonJS/ES module exports. A separate shell
tokenizer recognizes curl uploads of private keys or credential files while
excluding quoted examples, public keys and `--data-raw` literals.

The ten previously missed synthetic cases now receive REVIEW. The frozen
challenge has 57 malicious REVIEW, 33 malicious BLOCK and 90 benign SAFE. The
former holdout has ten malicious REVIEW and ten benign SAFE. Both have zero SAFE
misses, benign reviews or benign blocks. Calibration remains 29 malicious BLOCK
and one malicious REVIEW. Labels were not changed; historical results remain
preserved and CI now ratchets against `flow-results.json` and
`flow-holdout-results.json`.

Cycles, missing local modules and resource-limit exhaustion produce explicit
`flow-analysis-gap` REVIEW findings. One old test fixture was completed with its
missing local module. Two old expectations now assert REVIEW for oversized or
cyclic inputs; file inventory can be complete even when flow analysis is not.

The MCP proxy has an opt-in `--sandbox` mode. Its working directory is read-only,
networking is denied, and HOME/TMPDIR point to private disposable storage.
`--sandbox-read PATH` and `--sandbox-write PATH` grant additional existing paths.
Root and whole-HOME grants are refused. The macOS backend also denies subprocess
creation. Linux bubblewrap uses private namespaces and drops capabilities in the
child. Windows and unavailable/broken backends refuse to launch; there is no
unrestricted fallback.

```sh
# Run from a dedicated server project directory; use an installed launcher.
pkgxray mcp-proxy --sandbox -- node ./server.js
pkgxray mcp-proxy --sandbox --sandbox-write ./output -- node ./server.js
```

## Evidence

- Full local suite: **776 tests; 774 passed, 0 failed, 2 skipped**.
- Browser and Node agree on verdicts, scores and findings for all 270 existing
  calibration/challenge fixtures.
- New variations cover reassignment, shadowing, branch/loop overwrites, named and
  default imports, import chains, request aliases, shell examples, cycles,
  missing modules and resource exhaustion.
- Real macOS tests verify private-file denial, symlink-escape denial, read-only
  project access, explicit write grants, temporary HOME, blocked subprocesses,
  zero connections to the parent test server, and functioning MCP protocol gates.
- Linux parser and browser tests pass in a disposable Node 22 container. Linux
  confinement has **not** been verified: this Docker host blocks bubblewrap's
  namespace setup. The launcher refused rather than running the target without
  confinement. A mandatory native Linux CI job was added but has not yet run.
- Acorn archive SHA-512 was verified before copying. The unchanged parser file's
  SHA-256, upstream version and MIT license have regression checks; the browser
  bundle includes the license. OSV returned zero vulnerability records for Acorn
  8.18.0 at the time of this pass. This is a database check, not an independent
  parser security audit.
- Package dry-run: 43 files, including parser license/provenance. CI YAML parses,
  calibration/baseline commands pass and `git diff --check` passes.

## Scope and remaining limits

The former holdout and challenge inputs informed development; passing them is
not independent evidence of real-world detection accuracy. New obfuscation can
still evade analysis. General interprocedural side effects, native code, dynamic
resolution, arbitrary proxies/getters and TypeScript-specific syntax are not
fully modeled. Unsupported syntax retains lexical and independent checks.
Historical top-1000 results predate this engine and were not rerun.

Sandboxing is opt-in. Permitted files and explicitly passed environment values
remain accessible to the server. The sandbox does not solve kernel exploits,
CPU/memory exhaustion or malicious content sent through the authorized MCP
channel. Network-dependent servers, on-demand npx installation and macOS servers
that spawn subprocesses are intentionally incompatible with this restricted
mode. Validate backend behavior on each deployment OS before relying on it.
