# Changelog

## 1.0.6 (2026-07-30) — detection for the 2026 worm playbook

**In plain terms:** the first engine release since 1.0.1. Four new detector
bands close gaps that the 2025-26 npm worm families (Shai-Hulud and its
Mini/2.0 descendants, and the Sapphire Sleet campaigns against Axios and
Mastra) walked straight through, plus a fifth signal that reports without
gating. **Some packages that previously scanned as `safe` or bare `review` will
now be `block` or carry cited evidence** — see the severity policy in
[docs/reference.md](docs/reference.md).

This release also fixes two bugs that had shipped in every prior version and
only became visible once CI started running on Windows: `guard` could not scan a
local directory by absolute path there, and the MCP server leaked absolute paths
in its error replies. See **Windows fixes** below.

### What changed

- **New `cloud-metadata-access` band.** Reads of the cloud instance-metadata
  service (AWS/ECS link-local, GCP `metadata.google.internal`, the Azure token
  path) and of managed secret stores (Secrets Manager, Secret Manager, Key
  Vault, Vault) are now detected. Blocks from install-time code or next to an
  exfiltration sink; reviews when runtime code forwards the result to a second
  host. Harvesting host IAM credentials is the credential-theft step of the
  Shai-Hulud family, which previously produced no finding at all.
  **This band deliberately does not fire on cloud SDKs** — reading IMDS and
  returning the result is how ambient credentials are supposed to work, so a
  provider like `@aws-sdk/credential-provider-imds` still scans `safe`. A new
  benign fixture guards that line.
- **New `ci-workflow-injection` band.** Writing a CI/CD workflow
  (`.github/workflows/`, GitLab, CircleCI, Azure Pipelines, Jenkins) into the
  consuming repository is now detected. An injected workflow runs on the next
  push with the repository's secrets in scope — repository-level persistence
  that the existing shell-profile / crontab / launchd / Run-key checks stopped
  short of. Blocks from install-time code; a project scaffolder invoked on
  purpose reviews rather than blocks, mirroring how shell-completion installers
  are already treated.
- **New `self-deleting-dropper` band.** A script that unlinks its own file is
  anti-forensic cleanup — the shape used by the `easy-day-js` dropper in the
  Mastra compromise. Blocks when an install-time script deletes itself after
  fetching or executing a payload; reviews otherwise.
- **New `registry-self-publish` band.** Publishing to the registry from package
  code is the primitive that turned one compromised account into Shai-Hulud's
  796 packages. It is also what every release tool does, so the primitive alone
  is never the signal: this blocks only when the publish runs from install-time
  code, or when the code first asks the registry *which* packages the current
  credentials can reach — target selection by something that doesn't know whose
  account it landed in. `semantic-release`-style publishers and a `release` npm
  script both stay `safe`, with a benign fixture holding that line.
- **New `metadata-mimicry` signal, deliberately info-only.** Reports when a
  package publishes under a name that disagrees with its declared repository
  while running a consumer install hook — the manifest-copying that let
  `easy-day-js` pass review in the Mastra compromise. It is recorded as
  evidence and **never changes a verdict**; see the note below for why it
  cannot safely do more.
- **Callback-style download-then-execute is now caught.** The promise forms
  (`eval(await fetch(…))`, `.then(eval)`) were covered, but the older
  `res.on("end", () => new Function(body)())` accumulator was not — which left
  the unobfuscated Mastra dropper shape citing nothing but generic
  code-execution. Anchored on a stream-end handler so an ordinary JSON
  accumulator does not qualify.
- **Eight new calibration fixtures** (four malicious, four benign), all modeled
  on published advisories. The corpus is now 58 cases; block recall is 96.0%
  with **0 false blocks and 0 misses** held.
- **Fixed a quadratic-backtracking regex** in the new secret-store rule that
  cost 47s on the de-obfuscation perf fixture. The variable-length hostname run
  is now bounded; scan time is back at baseline.

### Calibration fixes found by self-scan

Running the new bands against pkgxray's own source caught two defects before
release; both now have regression tests.

- **Comments no longer trigger the new bands.** The metadata IP is quoted
  constantly in SSRF-defense code and in the comments explaining why it is
  blocked — pkgxray's own network guards do exactly that and self-scanned as
  three HIGH findings. The new detectors now match comment-stripped text, the
  same treatment the exfil-destination check already used.
- **"Install-time" now means hooks npm runs automatically.** Reachability was
  being computed from *every* `scripts` entry, so a file reached only by
  `npm test` or `npm run build` counted as install-time. The new bands key off
  a strict `preinstall`/`install`/`postinstall`/`prepack`/`prepare` seed set;
  a build script that reads instance metadata reviews rather than blocks.

### Why metadata-mimicry does not block

Worth recording, because it looks like a solvable problem and is not. Packages
disagree with their repository name constantly and legitimately: monorepos
(`react-dom` → facebook/react, `@types/node` → DefinitelyTyped,
`lodash.debounce` → lodash) and multi-artifact repos (`@sentry/cli` →
getsentry/sentry-cli). Every relation test that keeps `@sentry/cli` clean —
separator-insensitive containment being the obvious one — **also** matches
`easy-day-js` against `dayjs`, because a convincing typosquat is by
construction shaped exactly like a legitimate variant. Separating them needs
data the static engine does not have: who actually publishes the package versus
who owns the linked repository. So the discrepancy is surfaced as evidence for
the human reading a review, and the behavioral bands carry the verdict — which
they do, since a dropper still has to fetch, execute, or obfuscate.

### Windows fixes

CI ran only on Linux until this release, so several documented behaviors were
asserted by prose alone. Adding `windows-latest` and `macos-latest` to the test
matrix surfaced two bugs that had shipped in every prior version. Both are the
same root cause — path logic that assumed POSIX — and both now carry regression
tests that fail on Linux if they return, since a POSIX-shaped assertion is
exactly why they survived.

- **`guard` now accepts a Windows absolute path.** Deciding "is this a
  filesystem path?" was `reference.startsWith("/")`, which no Windows path
  satisfies, so `pkgxray guard C:\some\dir` fell through to the npm branch and
  asked the registry for a package literally named `C:\Users\…`. Scanning a
  local directory by absolute path never worked on Windows. Now uses
  `path.isAbsolute`, which is byte-identical to the old check on POSIX and also
  covers drive-letter and UNC roots.
- **The MCP server no longer leaks Windows paths in errors.** Error replies are
  scrubbed so a possibly-hostile caller cannot map the operator's filesystem,
  but both scrub patterns keyed on a leading `/`. On Windows the full path went
  back untouched — user profile and temp directory included. Drive-letter and
  UNC paths are now redacted the same way, keeping the basename for context.
  **If you run the MCP server on Windows, this is an information-disclosure fix,
  not a cosmetic one.**
- **Verdicts are confirmed identical across platforms.** The calibration
  benchmark now runs on Windows and macOS as well as Linux, with the same
  0 false blocks and 0 misses. Two macOS `sandbox-exec` tests — which back the
  canary threat model's claim that macOS is the only tier denying non-loopback
  egress at the OS boundary — executed for the first time in the project's
  history, and pass.

### Notes

- No CLI, JSON-schema, configuration, exit-code, or MCP contract changed. The
  new categories appear in `findings[].category` and `riskBands[]`, which
  the [compatibility policy](docs/compatibility.md) permits in a patch release
  (detection may become stricter as signatures improve).
- `docs/design/evasion-triage.md` listed the F4 bulk-env spread gap as open; it
  was closed by `BULK_ENV_CLONE_REGEXES` and the row is now marked accordingly.
- Windows and macOS are now blocking CI gates, not advisory ones. A handful of
  tests are skipped there for reasons recorded inline — POSIX mode bits, AF_UNIX
  path sockets, and control bytes in filenames have no Windows equivalent — and
  each notes why no behavior is left unasserted.

## 1.0.5 (2026-07-27) — accuracy & docs cleanup

**In plain terms:** a documentation, website, and CLI-clarity release. **No
detection, dependency, or verdict behavior changed** — same engine as 1.0.4.

### What changed
- **Execution wording is now precise everywhere.** Absolute "never executes
  untrusted code" claims are scoped to the default static path, since the opt-in
  `canary` deliberately executes package code in a sandbox. `pkgxray --help` is
  regrouped (Common / Evidence / Advanced) and the canary line states plainly
  that it EXECUTES untrusted package code and needs `--yes-run-untrusted-code`.
- **Calibration pages reconciled.** The 5,000-package denominator is described
  the same way on every page (top-1000 + two deeper sweeps of 1,000 and 3,000;
  the MCP cohort and malware corpus are separate), the run's pre-release engine
  and commit-checkout reproduction are disclosed, and the annual malware figure
  cites Sonatype's primary report.
- **Shorter README.** Trimmed to a focused overview with depth relocated to
  `docs/` (including a new `docs/comparison.md`); integrations surfaced.
- **MCP Registry claim corrected** to match the live registry (see the 1.0.4
  note below).

## 1.0.4 (2026-07-20) — listed on the MCP Registry

**In plain terms:** pkgxray's built-in MCP server can now be found and
installed straight from the official Model Context Protocol registry, so any
AI coding assistant can add it in one step. No scanning behavior changed.

> **Note (2026-07-26):** The MCP Registry is still in preview and periodically
> resets its data. A live lookup of `io.github.adamsjack711-ux/pkgxray` may
> currently return no entry, in which case it needs re-submission — see
> [docs/mcp-registry.md](docs/mcp-registry.md). Local and `npx` setup does not
> depend on the Registry.

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
