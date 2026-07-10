# Changelog

## Unreleased — security audit hardening + shared config

A full audit of the detection engine and every surrounding subsystem, the
resulting fixes, and a new shared configuration layer.

### Added
- **EtherHiding / on-chain command-channel detection** (`onchain-c2-loader`). A
  blockchain-state read used to fetch a payload — `eth_getTransactionByHash`,
  TronGrid / Aptos account-transaction endpoints, EVM seed RPCs — co-located with
  a code executor (`eval` / `new Function` / `vm` / `child_process`) blocks as
  the EtherHiding shape: the chain is the command channel, so the committed
  loader never changes and there is no server to seize. A chain-read plus a raw
  calldata-extraction step (`tx.input.slice(2)` / Tron `raw_data.data`) without a
  visible executor is flagged for review. A plain chain-read that only reports
  status stays safe, so ordinary web3 libraries are not swept up.
- **Hidden self-`node -e` execution detection.** A `child_process` call that runs
  Node itself on an inline `-e`/`--eval` script is eval-by-subprocess; paired
  with an evasion option (`windowsHide` / `detached` / `stdio:'ignore'`) it blocks
  as a deliberately-silent, process-outliving stage-2 executor. The plain,
  unhidden form is review.
- **`.pkgxray.json` shared configuration** (`src/config.js`). One human-authored
  policy file read by the CLI, the MCP server, and the proxy through a single
  loader — no per-surface drift. Zero config is fully safe; the model is
  *tighten freely, loosen loudly*. Two invariants are enforced in code:
  allowlist entries must be pinned to `name@version` + `sha256`, and a published
  vulnerability can never be muted or allowed away. Muted findings stay visible
  in the report; every loosening is surfaced. See `docs/config.md`.
- Wired the config into all three surfaces: the CLI (`guard` / `audit` /
  single-file), the MCP server (tool-exposure filtering + stricter agent
  defaults), and the example proxy (shared policy governs the gate).
- Centralized fail-closed handling: a scan that errors/times out maps to
  `review`, never silently `safe`; CI exit codes honor a configurable `failOn`.

### Fixed — detection bypasses (verdicts that were falsely `safe`/`review`)
- **De-obfuscation no longer skips files over 100 KB** — split-string credential
  paths in large files are now folded and caught.
- **Static base64/`atob` decoding** of string-literal credential paths.
- **Runtime require-graph awareness** — a payload in `examples/…` reached from
  the package entrypoint is no longer downgraded as a "test fixture".
- **IP-encoding evasion** — decimal-dword, hex-dword, and IPv6 URL hosts are now
  detected (previously IPv4-dotted-quad only).
- **Column-wrapped base64** injection payloads in docs/comments are decoded.
- Modest non-English prompt-injection phrase coverage (review tier).
- The **browser extension is regenerated** from the current engine (the shipped
  copy had drifted far behind `src/auditor.js`).

### Fixed — coverage & extraction
- **Modern pnpm lockfiles (v9, the current default) now parse** — they were
  silently scanning to zero dependencies. v5/v6/v9 all handled.
- **Oversized files are scanned, not omitted** — files over the per-file cap are
  head+tail sliced instead of dropped, so a padded payload can't hide.
- **Tarball hardlink / newline entries are rejected**; extraction fails closed
  rather than letting a malformed entry abort (and thus skip) the scan.
- npm/yarn **aliases and url/workspace deps** are resolved or surfaced, not
  emitted to OSV as a false `safe`.

### Fixed — baseline & monitoring integrity
- A stored `.pkgxray.lock` `allow` can **no longer override a fresh OSV block**.
- `recheck` honors its **staleness gate** — an ancient/`checkedAt`-less baseline
  is no longer trusted as "unchanged".
- Version-drift no longer **fails open** when every update candidate errors.
- `.pkgxray.lock` writes are **atomic** (temp + rename).

### Fixed — MCP server adapter (the one place untrusted code runs)
- `PATH` is no longer inherited into the spawned server (untrusted-binary
  hijack); a minimal fixed `PATH` + an env denylist are used.
- Process-group kill hardened; the SIGKILL timer is no longer skippable on the
  timeout path. (The residual `setsid` grandchild escape is documented.)
- **HTTP transport SSRF guard** — loopback/private/link-local/metadata hosts are
  refused, with DNS-rebind pinning; opt out with `PKGXRAY_MCP_ALLOW_PRIVATE=1`.
- The rug-pull **pin fingerprint now covers `annotations`, `instructions`, and
  `capabilities`** (previously a post-approval flip of those went undetected).

### Fixed — network / cache / attestation
- `github.js` **re-validates redirect targets** and refuses `http://` downgrade
  (SSRF); JSON responses are size-capped.
- The self-hosted **cache server** no longer falls back to its own token for a
  tokenless client (confused-deputy); upstream JSON is size-capped; a disk cap
  was added.
- **Attestation strings no longer overclaim** — pkgxray parses SLSA provenance
  but does not cryptographically verify it; the code and rationale now say so
  plainly, a subject-digest binding helper was added, and the non-offsetting
  invariant (a forged attestation can never move a verdict toward safe) is
  retested. (Full sigstore/Fulcio/Rekor verification remains out of scope under
  the zero-dependency constraint.)

### Sandbox
- The opt-in canary sandbox kills the whole process group and keeps the egress
  capture proxy alive for a grace window, so a delayed beacon is still recorded.
