# Changelog

## 1.0.5 (2026-07-21) — second at-scale sweep: two false-block shapes closed

**In plain terms:** we ran the false-block validation over a *fresh* 1,000
most-downloaded packages — a set with zero overlap with the original top-1000 —
and it surfaced two popular packages that were wrongly blocked: **wrangler**
(Cloudflare's Workers CLI) and **@dotenvx/dotenvx** (the dotenv successor). Both
are now correctly `review`, not `block`. No malware detection was weakened — the
full malicious corpus still blocks, precision stays 100%.

### What changed
- **A single named env var is no longer misread as a whole-environment
  harvest.** `JSON.stringify(process.env[name])` reads *one* variable; the
  bulk-env regex matched `process.env` before the `[key]` index and treated it
  as a full harvest, so in the same bundled file as network calls it false-blocked
  wrangler. `JSON.stringify(process.env)` (the real harvest shape) still blocks.
- **Tunnel / reverse-proxy endpoints are dual-use, routed to `review` not
  `block`.** `trycloudflare.com`, `ngrok.io`, `serveo.net`, `loca.lt` were in the
  same HIGH list as pure exfil sinks, so the official package for each tunnel
  product false-blocked on its own endpoint. Pure exfil domains (webhook.site,
  pastebin, oast.*) still block.
- **A `__dirname`-relative dynamic require no longer corroborates a token-exfil
  block.** `require(__dirname + '/…')` resolves to a shipped local file the scan
  can already see, so it cannot hide a network/exec sink; only a computed
  *non-local* require beside a bulk-env harvest blocks.
- **Reading `.env` / `.env.keys` with no exfil sink is config-loading, not
  credential theft.** A `.env` file is the app's own project config, not a global
  credential store — so a read with no network sink and no shell/exec primitive
  in the file is `INFO`, mirroring the `.npmrc`/registry-url calibration. A `.env`
  read that also exfils still blocks. This unblocks dotenvx and every dotenv-style
  loader.
- **Four new benign regression fixtures** (`benchmark/corpus/benign/`) lock each
  fix into the CI calibration gate.

## 1.0.4 (2026-07-20) — listed on the MCP Registry

**In plain terms:** pkgxray's built-in MCP server can now be found and
installed straight from the official Model Context Protocol registry, so any
AI coding assistant can add it in one step. No scanning behavior changed.

### What changed
- **Published to the [MCP Registry](https://registry.modelcontextprotocol.io)**
  as `io.github.adamsjack711-ux/pkgxray`, with a `server.json` describing how
  to launch it.
- **New `pkgxray mcp-server` command** runs pkgxray itself as an MCP server.
  Hosts that prefer zero-install can now start it with
  `npx -y pkgxray mcp-server` (the locally-installed `pkgxray-mcp` still works
  exactly as before). This is separate from `pkgxray mcp <target>`, which
  *audits* someone else's MCP server.
- No detection, dependency, or verdict changes.

## 1.0.3 (2026-07-18) — a shorter, sharper README

**In plain terms:** docs-only release. The package's code is identical to
1.0.2 — this exists so the npm page picks up the condensed README.

### What changed
- **The README is ~40% shorter** (458 → 277 lines) with nothing lost: the
  statistics essay became one sentence, six feature subsections merged into
  the "What it catches" table plus a short "Beyond detection" list, and
  everything cut is still one link away in `docs/`.
- **npm renders it correctly now.** GitHub-only `[!NOTE]` alert boxes — which
  show up as literal `[!NOTE]` text on npm — were rewritten as plain prose,
  and a dead in-page link to the comparison table was fixed.
- The project website's source now lives in the repo (`website/`), with
  social-share card images. This doesn't affect the npm package contents.
- No code, dependency, or behavior changes of any kind.

## 1.0.2 (2026-07-14) — the README shows itself working

**In plain terms:** docs-only release. The package's code is identical to
1.0.1 — this exists so the npm page picks up the new README, whose old
screenshots pointed at files that no longer exist in the repo.

### What changed
- **The hero is now a live recording.** An animated GIF of real `pkgxray
  guard` runs — `express` clearing, then a trojaned sample (modeled on the
  2024 `@solana/web3.js` compromise) blocked with cited evidence — replaces
  the static screenshots, plus a 60-second MP4 walkthrough.
- **Every capture shares one warm terminal theme,** including the re-captured
  MCP-proxy and hookshot stills (now unedited live sessions) and the browser
  extension popup.
- No code, dependency, or behavior changes of any kind.

## 1.0.1 (2026-07-12) — a safer "detonation" sandbox

**In plain terms:** pkgxray normally inspects a package *without* running it. The
optional `pkgxray canary` command is the one exception — you opt in, and it
actually *runs* a package's install scripts inside a locked room to watch what
they do. We seed that room with fake passwords ("decoys") and route all network
traffic into a recorder that never lets it out, so if the package tries to steal
a secret and phone home, we catch it red-handed.

This release makes that locked room genuinely locked. A review found several
ways a sneaky package could slip out or hide — this closes them. It only affects
the opt-in `canary` command; nothing else changes.

### What got safer
- **We now catch disguised secret theft.** Before, we only spotted a stolen fake
  password if the package sent it out as-is. If it scrambled it first (base64,
  hex, etc.), we missed it. Now we check for the common disguises too, so a
  one-line trick no longer beats the trap.
- **The room actually blocks the internet now (macOS).** Previously a package
  could open its own direct connection and sneak data out around our recorder.
  On macOS the sandbox now blocks all outside network access except the internal
  recorder — so that escape route is closed at the operating-system level.
- **Your real secrets are hidden (Linux).** The sandbox used to leave your
  *actual* `~/.aws`, `~/.ssh`, and `~/.npmrc` readable. Now they're hidden behind
  an empty folder, so a package only ever sees the fakes.
- **A runaway package can't wreck the machine.** The code being tested now runs
  with limits on CPU time, file size, and crash dumps, so it can't peg your
  processor or fill your disk while we watch it.

### What got fixed
- **A package can no longer freeze the scan.** One that held a network connection
  open forever used to make pkgxray hang. It now cleans up and moves on.
- **A clean result is now honestly labelled.** A quiet run used to say `safe`,
  which sounds like "this package is fine." But watching a package once can only
  ever *catch* bad behaviour — it can't *prove* good behaviour (clever malware
  stays quiet when it senses it's being watched). So a clean run now says
  **`not-observed`** ("we didn't see anything this time"), never `safe`. The
  normal (non-canary) scan is unchanged.
- **Odd folder names can't break the sandbox rules** (a path with a quote or
  backslash is now escaped safely).

_For developers:_ the `canary` command's JSON output is an
[Experimental surface](docs/json-schema.md); its `schemaVersion` moves `1 → 2`
because of the `safe` → `not-observed` rename. New fields: `netConfined`,
`resourceLimited`.

## 1.0.0 (2026-07-11) — 0 false blocks at scale; the stability contract is in force

The final item on the [path to 1.0](docs/compatibility.md#path-to-10) is
complete: the "0 false blocks" claim is now proven against real packages nobody
wrote as a test, not just a curated corpus. Every box on the checklist is
checked, so the [compatibility contract](docs/compatibility.md) now binds — a
breaking change to a **Stable** surface requires a major bump.

### Added
- **Top-1000 validation harness** (`scripts/validate-at-scale.js`,
  `validation/`). Runs `pkgxray guard` over the 1,000 most-depended-upon npm
  packages, classifies every verdict, and gates on **0 heuristic false blocks**
  (exit non-zero otherwise). Zero-dependency, reproducible against a committed
  corpus. Correct known-CVE blocks and audited *defensible* blocks (a package
  that genuinely performs the flagged operation — `pm2` installs boot
  persistence) are separated out; `error` (unpublished-since) is never a block.
  The first run surfaced **22 false blocks across ~7 detectors** — all now
  calibrated and each captured as a benign benchmark fixture.

### Fixed — calibration false blocks (top-1000, all now `review`/`safe`)
- **Dual-use URL shorteners no longer BLOCK.** A `goo.gl` / `bit.ly` in an
  error/doc link (bluebird, node-gyp, firebase, react-scripts, pm2, …) no longer
  escalates to a HIGH exfil block; only a hardcoded IP or a no-legitimate-use
  paste/webhook/OAST domain does. A lone shortener is review — matching the
  engine's own long-standing "not enough on its own to flag" comment.
- **Shell tab-completion installers no longer BLOCK.** `<tool> completion >>
  ~/.bashrc` (npm, and karma/pm2/yeoman which copied its model) is a documented
  user-invoked convenience, reviewed rather than blocked. Crontab / systemd /
  launch-agent / init.d / Windows Run-key writes still BLOCK.
- **Transform test-fixtures no longer BLOCK.** A `.txt`/`.md` fixture read + `vm`
  in a `test/` path (brfs, watchify, node-sass) is allowed the test-path
  downgrade; an *opaque* payload blob (`.dat`/`.bin`/`.enc`) still stays HIGH
  even in tests. A method call `b.require(x)` (browserify's bundler API) no
  longer matches the dynamic-require exfil shape.
- **Large legitimate bundles no longer BLOCK on obfuscation.** The decode→execute
  heuristic now requires the decoder and executor within ~600 chars (pouchdb's
  atob polyfill sits far from its view-compiler `new Function`), and the base64
  DECODE regex no longer matches the ENCODE form `.toString("base64")` (webpack's
  inline-sourcemap devtool).
- **Build artifacts no longer BLOCK as artifact-only-malware.** A generic
  `code-execution` / `dynamic-require` in a file that diverges from git source
  (Angular's fesm2022 bundles, Babel `.bc.js`, the requirejs r.js optimizer) no
  longer correlates to a tamper block — every transpiled artifact contains those.
  A genuine injected conduct payload (exfil / credential / persistence / …) still
  does.
- **Comments are no longer read as conduct.** An example IP (superagent's
  `// request.get('https://1.2.3.4/')`), an Apache license URL in `binding.gyp`
  (grpc), and a link to the `ExodusOSS` GitHub org (jsdom) no longer fire the
  exfil / native-build-fetch / crypto-wallet detectors. A `binding.gyp` action
  that merely `echo`es a build-help URL needs an actual fetch tool (curl/wget/…)
  to block. Doc-site bundles under `docs/`/`website/` get the non-runtime
  downgrade (datafire).
- **A 404 GitHub repo is now REVIEW, not BLOCK.** A deleted/renamed repo behind
  an abandoned-but-legitimate package (optimist → `substack/node-optimist`) is
  indistinguishable from a typosquat's fake link on the 404 alone, so it is
  flagged for review rather than blocked.

## 0.18.0 (2026-07-10) — EtherHiding detection, calibration benchmark, path to 1.0

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
- **Calibration benchmark** (`benchmark/run.js`) — a 30-fixture advisory-modeled
  corpus (benign and malicious) with hard CI gates (0 false blocks, 0 full
  misses), making the calibration claim reproducible on every push.
- **Self-guarding release workflow** — publishing a GitHub Release runs tests,
  the calibration benchmark, and pkgxray's own supply-chain guard over the
  packed artifact before publishing to npm with provenance.
- **Path-to-1.0 freeze** — the JSON output schema (`docs/json-schema.md`) and
  the exit-code mapping are pinned by contract tests; CI runs a Node
  18/20/22/24 matrix; `mcp`, `mcp-proxy`, and the cache server graduated to
  Stable; canary sandbox hardened with a documented threat model.

### Fixed
- **MCP spawn PATH resolution** — bare stdio commands are resolved in the
  parent process (minimal system dirs first, then the operator's PATH with
  package-writable dirs stripped), so launchers outside the fixed system dirs
  no longer fail ENOENT. The child env stays fully scrubbed; an operator-PATH
  hit is surfaced as a diagnostic naming the exact binary.
- **Provenance-verified self-scan reports REVIEW, not BLOCK** — `pkgxray guard
  pkgxray` no longer blocks on its own signature database. The downgrade is
  verification-gated on npm↔GitHub parity against the canonical repo, so
  typosquats, forks, and tampered tarballs keep the full verdict; conduct
  findings (OSV vulnerabilities, install hooks) never downgrade.
- The MCP server reports the real package version (was hardcoded at 0.12.0).
- Exec-snippet null crash on encoded `child_process` payloads.
- node-ipc-style in-place file corruption (logic bomb) is now caught by the
  destructive-payload detector.

## 0.17.0 (2026-07-08) — security audit hardening + shared config

A full audit of the detection engine and every surrounding subsystem, the
resulting fixes, and a new shared configuration layer.

### Added
- **`.pkgxray.json` shared configuration** (`src/config.js`). One human-authored
  policy file read by the CLI, the MCP server, and the proxy through a single
  loader — no per-surface drift. Zero config is fully safe; the model is
  *tighten freely, loosen loudly*. Two invariants are enforced in code:
  allowlist entries must be pinned to `name@version` + `sha256`, and a published
  vulnerability can never be muted or allowed away. Muted findings stay visible
  in the report; every loosening is surfaced. See `docs/configuration.md`.
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
