# pkgxray demonstration scripts

These ten scripts are recording plans, not simulated product output. Run them
from the repository root with Node.js 18 or newer and the current `pkgxray`
binary on `PATH`. The quoted output below contains only stable key lines seen in
reproducible runs; elapsed time, vulnerability counts, upstream advisory IDs,
npm/GitHub metadata, scores as detection calibration changes, and temporary
quarantine locations may vary.

Recording rules shared by every demo:

- Use a clean terminal with a generic prompt such as `$`; do not show the home
  directory, local username, tokens, environment dumps, registry credentials,
  or quarantine paths.
- Never open or execute a staged package. `guard` statically scans the staged
  bytes and does not run `npm install`, lifecycle scripts, build steps, or
  package code.
- Every malicious example below is a **reconstructed, advisory-modeled fixture,
  never live malware**. The fixtures are reduced samples committed under
  `benchmark/corpus/malicious/`.
- `SAFE` means no high- or medium-risk indicator was found in the available
  evidence. Static scanning cannot prove safety. A clean tarball can fetch a
  later-stage payload after installation; use least privilege and runtime
  sandboxing where that risk matters.
- Capture exit status immediately after the command it describes. In shell
  snippets, `rc=$?` does that without relying on a later command.

## 1. Thirty-second package gate

**Purpose and timing:** Show the product loop in two cuts: a known package
clears, then a reconstructed malicious sample is rejected with cited evidence.

**Exact terminal commands**

```bash
docs/demo/setup.sh
pkgxray guard npm:express@4.21.0
pkgxray guard /tmp/pkgxray-demo/sample-malicious-pkg
rc=$?; printf 'exit code: %s\n' "$rc"
```

**Expected output:** The registry-backed fields can change with current
upstream data. In a reproduced run, the stable lines were:

```text
Decision: **SAFE**
Reference: `npm:express@4.21.0`
Verdict: **SAFE**
No high- or medium-risk indicators were found in the provided evidence.
...
Decision: **BLOCK**
Verdict: **BLOCK**
Package: `solana-web3-helper`
- **HIGH credential-access** — Reads a path to a credential / wallet / key store near a filesystem read. (`index.js`)
exit code: 2
```

**Screen sequence:** 0–3 s title card, 3–13 s type and run the Express guard,
13–16 s hold on `SAFE`, 16–25 s run the fixture guard, 25–30 s frame
`credential-access` and exit code `2`. Crop the report rather than scrolling
through all parameter grades.

**Voiceover / captions:** “Inspect what gets installed before it executes.
Express has no high- or medium-risk indicator in this run. This reconstructed
fixture, modeled on the 2024 Solana web3 compromise, reads wallet material, so
pkgxray blocks it and returns CI-ready exit code two.”

**Blur or exclude:** Blur the `Quarantine:` value and any shell title containing
a local path. Exclude setup output, network timing, the fixture's attacker-like
URL, and all local account details.

**Reproduction:** `docs/demo/setup.sh` materializes the malicious package in
`/tmp/pkgxray-demo` from
`benchmark/corpus/malicious/advisory-solana-web3-keytheft.json`. No fixture
bytes come from the live npm registry.

**Disclaimer:** The first result is a point-in-time static and intelligence
decision, not proof that Express or any package is harmless. The second sample
is reconstructed/advisory-modeled, never live malware.

## 2. Sixty-second package-and-lockfile story

**Purpose and timing:** Reproduce the existing three-act walkthrough: package
`SAFE`, fixture `BLOCK`, then a vulnerable lockfile `BLOCK`.

**Exact terminal commands**

```bash
docs/demo/setup.sh
cd /tmp/pkgxray-demo
pkgxray guard npm:express@4.21.0
pkgxray guard ./sample-malicious-pkg
rc=$?; printf 'exit code: %s\n' "$rc"
pkgxray audit ./package-lock.json
rc=$?; printf 'exit code: %s\n' "$rc"
```

For the existing unedited VHS recording:

```bash
vhs docs/demo/demo.tape
```

**Expected output:** A reproduced run showed these stable key lines:

```text
Decision: **SAFE**
Package: `express`
- **INFO npm-vs-github-clean** — npm tarball matches the linked GitHub repo at the published version.
...
Decision: **BLOCK**
Package: `solana-web3-helper`
- **HIGH credential-access** — Reads a path to a credential / wallet / key store near a filesystem read. (`index.js`)
exit code: 2
...
Lockfile: `./package-lock.json` (npm)
Total deps: 2
Decision: **BLOCK**
safe: 1  ·  review: 0  ·  block: 1
- **lodash@4.17.11**
exit code: 2
```

The exact GitHub match count, scan time, advisory IDs, and number of current
OSV records may vary.

**Screen sequence:** 0–5 s product statement; 5–20 s Express result; 20–39 s
label the sample “RECONSTRUCTED / ADVISORY-MODELED” and show its block; 39–44 s
show exit `2`; 44–58 s audit the two-dependency lockfile; 58–60 s end card.

**Voiceover / captions:** “First, a real registry package clears with an
npm-to-GitHub comparison. Next, a reconstructed advisory fixture is blocked on
credential access. Finally, one lockfile command checks every pinned dependency
against OSV and rejects the vulnerable Lodash pin.”

**Blur or exclude:** Blur quarantine values and genericize the prompt. Do not
show a home path, npm auth configuration, full advisory URLs, or notifications.

**Reproduction:** The commands and pacing are also recorded in
`docs/demo/demo.tape`; fixture creation is in `docs/demo/setup.sh`. The lockfile
contains only `express@4.21.0` and `lodash@4.17.11`.

**Disclaimer:** OSV and repository metadata are network-dependent and may
change. The malicious package is reconstructed/advisory-modeled, never live
malware. Static analysis cannot prove safety or see a later-stage payload absent
from the tarball.

## 3. Three-minute narrated walkthrough

**Purpose and timing:** Explain the three verdicts, MCP connect-time checking,
and automation without hiding limitations.

**Exact terminal commands**

```bash
# 0:00–0:15 — stage only committed demo fixtures
docs/demo/setup.sh

# 0:15–0:45 — real package
pkgxray guard npm:express@4.21.0

# 0:45–1:10 — deterministic REVIEW fixture, no network and no execution
node -e 'process.stdout.write(JSON.stringify(require("./benchmark/corpus/benign/install-hook-benign.json").evidence))' \
  | pkgxray
rc=$?; printf 'exit code: %s\n' "$rc"

# 1:10–1:40 — reconstructed malicious fixture
pkgxray guard /tmp/pkgxray-demo/sample-malicious-pkg
rc=$?; printf 'exit code: %s\n' "$rc"

# 1:40–2:15 — controlled local MCP fixture; this intentionally starts it
pkgxray mcp --no-package-scan --timeout 5000 node ./docs/screenshots/demo-mcp-server.js
rc=$?; printf 'exit code: %s\n' "$rc"

# 2:15–2:40 — lockfile CI result
pkgxray audit /tmp/pkgxray-demo/package-lock.json
rc=$?; printf 'exit code: %s\n' "$rc"

# 2:40–3:00 — calibration
npm run benchmark
```

**Expected output:** Quote only these reproduced lines:

```text
Decision: **SAFE**
Package: `express`
...
Verdict: **REVIEW**
Package: `native-dep`
- **MEDIUM lifecycle-script** — Runs a script at install time with the installing user's privileges.
exit code: 3
...
Decision: **BLOCK**
- **HIGH credential-access**
exit code: 2
...
pkgxray: note — enumerating a stdio MCP server SPAWNS it.
Manifest verdict: **BLOCK**
- [HIGH] injection-attempt
- [HIGH] capability-mismatch
exit code: 2
...
false blocks    : 0
full misses     : 0
All hard-gate checks passed ✓
```

Benchmark totals and metrics evolve as fixtures are added; do not burn the
current case count into narration.

**Screen sequence:** Use six chapter cards matching the comments above. Zoom
only the verdict, evidence category/file, and exit code. During the MCP chapter,
keep the stdio execution warning on screen. During calibration, highlight that
the claim is about the committed corpus, not all packages.

**Voiceover / captions:** “Safe clears, review pauses for a human, and block
rejects. The review sample contains a legitimate-looking postinstall and is not
called malicious. The blocked package is a reconstructed public-advisory
fixture. MCP manifest enumeration can detect injected descriptions and
over-broad schemas, but starting a stdio server executes it; package-scan-first
is the safe order. Exit codes make the same policy usable in CI.”

**Blur or exclude:** Exclude the fixture source URL, quarantine paths, machine
timings, usernames, tokens, and any unrelated desktop UI. Do not crop out the
MCP spawn warning.

**Reproduction:** The package fixtures are under `benchmark/corpus/`, the MCP
server is `docs/screenshots/demo-mcp-server.js`, and the lockfile is generated
by `docs/demo/setup.sh`. `npm run benchmark` invokes `benchmark/run.js`.

**Disclaimer:** The MCP command uses `--no-package-scan` only because it starts
a controlled repository fixture. For an unknown stdio server, scan its package
first. Static package and manifest scans are risk controls, not proof of safety,
and cannot inspect a payload downloaded later at runtime.

## 4. Safe static package fixture

**Purpose and timing:** Give a fully offline, deterministic `SAFE` demonstration
that does not depend on a registry.

**Exact terminal commands**

```bash
node -e 'process.stdout.write(JSON.stringify(require("./benchmark/corpus/benign/plain-utility.json").evidence))' \
  | pkgxray
rc=$?; printf 'exit code: %s\n' "$rc"
```

**Expected output:** This was reproduced against the committed fixture:

```text
Verdict: **SAFE**
Grade: **A+** (99/100)
No high- or medium-risk indicators were found in the provided evidence.
Package: `is-thing`
- **INFO missing-metadata** — Provenance metadata (npm registry / GitHub) absent or weak; cross-checks skipped.
exit code: 0
```

The score may move as calibration changes; the verdict, fixture package name,
missing-metadata note, and exit-code contract are the useful capture.

**Screen sequence:** Show the fixture path in the command, then hold on `SAFE`,
the explicit missing-metadata note, and exit `0`. This makes the evidence limit
visible rather than presenting a context-free green badge.

**Voiceover / captions:** “This pure utility fixture has no high- or medium-risk
indicator, so the static engine returns Safe and zero. Metadata was not
supplied, so pkgxray says those cross-checks were skipped.”

**Blur or exclude:** Nothing in this fixture is secret, but retain the generic
prompt and exclude full filesystem roots or terminal titles.

**Reproduction:** The input is the `evidence` object in
`benchmark/corpus/benign/plain-utility.json`. The one-line Node command extracts
that object because fixture labels such as `expect` belong to the benchmark,
not the CLI evidence schema.

**Disclaimer:** `SAFE` is scoped to supplied evidence and cannot prove safety.
This synthetic benign fixture does not demonstrate registry, OSV, provenance,
or npm-to-GitHub checks, and static scanning cannot see a later-stage payload.

## 5. REVIEW is a pause, not an accusation

**Purpose and timing:** Demonstrate that a normal install-time capability is
routed to human review rather than mislabeled malicious.

**Exact terminal commands**

```bash
node -e 'process.stdout.write(JSON.stringify(require("./benchmark/corpus/benign/install-hook-benign.json").evidence))' \
  | pkgxray
rc=$?; printf 'exit code: %s\n' "$rc"
```

**Expected output:** Reproduced stable lines:

```text
Verdict: **REVIEW**
Package: `native-dep`
Manual review required: 1 medium-severity finding(s) or incomplete evidence prevent a safe verdict.
- **MEDIUM lifecycle-script** — Runs a script at install time with the installing user's privileges. (`package.json`)
Evidence: `"postinstall": "node ./scripts/rebuild.js"`
exit code: 3
```

**Screen sequence:** Start on the package's benign rebuild script description,
run the command, then highlight `REVIEW`, `lifecycle-script`, the exact
`postinstall` evidence, and exit `3`.

**Voiceover / captions:** “A postinstall is not automatically malware, but it
runs during installation with the user's privileges. pkgxray asks for review
and cites the exact script instead of silently allowing or falsely blocking it.”

**Blur or exclude:** Exclude unrelated report sections if time is short, but do
not hide the evidence line or convert the yellow review state into a red block.
Do not show local paths.

**Reproduction:** Input comes from
`benchmark/corpus/benign/install-hook-benign.json`; the benchmark labels this
fixture `review`, and the static CLI returns exit `3`.

**Disclaimer:** The fixture is benign by construction and demonstrates policy,
not malware detection. Human review still must inspect what the lifecycle
script and its dependencies do. Static analysis cannot prove safety or rule out
a downloaded later-stage payload.

## 6. Reconstructed malicious fixture BLOCK

**Purpose and timing:** Show file-level evidence for a known attack shape
without downloading or executing a malicious package.

**Exact terminal commands**

```bash
docs/demo/setup.sh
pkgxray guard /tmp/pkgxray-demo/sample-malicious-pkg
rc=$?; printf 'exit code: %s\n' "$rc"
```

For an entirely static stdin variant:

```bash
node -e 'process.stdout.write(JSON.stringify(require("./benchmark/corpus/malicious/advisory-solana-web3-keytheft.json").evidence))' \
  | pkgxray
rc=$?; printf 'exit code: %s\n' "$rc"
```

**Expected output:** The staged-package run reproduced:

```text
Decision: **BLOCK**
Reference: `/tmp/pkgxray-demo/sample-malicious-pkg`
Verdict: **BLOCK**
Package: `solana-web3-helper`
- **HIGH credential-access** — Reads a path to a credential / wallet / key store near a filesystem read. (`index.js`)
- **INFO network-access** in `index.js`: Performs outbound network activity.
exit code: 2
```

**Screen sequence:** Put a persistent “RECONSTRUCTED ADVISORY FIXTURE — NOT LIVE
MALWARE” banner above the terminal. Show setup source attribution, run guard,
then frame `credential-access`, `index.js`, and exit `2`.

**Voiceover / captions:** “This is not a recovered malware package. It is a
minimal reconstructed fixture modeled on the public 2024 Solana web3 advisory.
The real static engine sees a wallet-path read and outbound network capability,
cites the file, and blocks.”

**Blur or exclude:** Blur the generated quarantine path. Exclude the
attacker-like test hostname, local paths other than `/tmp/pkgxray-demo`, and any
claim that the exact historical malware bytes are being scanned.

**Reproduction:** `docs/demo/setup.sh` writes a minimal `package.json` and the
fixture's `index.js` into `/tmp/pkgxray-demo/sample-malicious-pkg`. The source of
truth is
`benchmark/corpus/malicious/advisory-solana-web3-keytheft.json`.

**Disclaimer:** This is reconstructed/advisory-modeled, never live malware, so
it demonstrates detection of a represented attack shape rather than
live-registry recall. Static scanning cannot prove other packages safe and can
miss a later-stage payload not present in scanned bytes.

## 7. MCP manifest audit

**Purpose and timing:** Show connect-time detection of prompt injection and a
capability-surface mismatch while making the stdio execution boundary explicit.

**Exact terminal commands**

The reproducible controlled-fixture command is:

```bash
pkgxray mcp --no-package-scan --timeout 5000 node ./docs/screenshots/demo-mcp-server.js
rc=$?; printf 'exit code: %s\n' "$rc"
```

The safe order for a real packaged stdio server is package scan first:

```bash
pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server
```

**Expected output:** The local fixture run reproduced:

```text
pkgxray: note — enumerating a stdio MCP server SPAWNS it. No package scan was requested; pass --package <ref> to statically vet the server first.
Server: **demo-server** v1.0.0
Tools (3):
Manifest verdict: **BLOCK**
- [HIGH] injection-attempt in `mcp-manifest/tool-summarize_page.md`
- [HIGH] capability-mismatch in `mcp-manifest/tool-get_weather.md`
exit code: 2
```

**Screen sequence:** First show a card reading “stdio enumeration executes the
server.” Keep the emitted warning visible, then show the three tool names, zoom
the injected `summarize_page` description finding, and finish on the weather
tool's unexpected `command` parameter.

**Voiceover / captions:** “`pkgxray mcp` performs a read-only handshake and
`tools/list`; it does not call a tool, resource, or prompt. But a stdio server
must be spawned to enumerate it. For unknown software, pass `--package` so the
no-execution package scan happens first. This controlled fixture is blocked for
prompt injection and an over-broad command capability.”

**Blur or exclude:** Do not hide the spawn warning. Exclude environment output,
tokens, authorization headers, and real private MCP endpoints.

**Reproduction:** The controlled server is
`docs/screenshots/demo-mcp-server.js`. It exposes three deterministic tool
definitions and exits after the client session. `--no-package-scan` is
intentional only for this reviewed local fixture.

**Disclaimer:** `pkgxray mcp` **can execute a stdio server** to enumerate it;
its scrubbed environment, timeout, bounded output, and process cleanup reduce
risk but do not make unknown code safe. Always use package-scan-first when a
package reference exists. Manifest inspection and static scans cannot prove
safety or see a later-stage runtime payload.

## 8. Coding-agent install gate

**Purpose and timing:** Show a simulated agent `PreToolUse` event denied before
`npm install` runs.

**Exact terminal commands**

Build from a hookshot checkout without exposing its absolute location:

```bash
export HOOKSHOT_CHECKOUT=/path/to/hookshot
HOOKSHOT_CHECKOUT="$HOOKSHOT_CHECKOUT" docs/demo/setup.sh
export PATH="/tmp/pkgxray-demo:$PATH"
echo '{"tool_name":"Bash","tool_input":{"command":"npm install lodash@4.17.11"}}' \
  | pkgxray-guard claude-pre-tool-use \
  | jq -r '.hookSpecificOutput | .permissionDecision, .permissionDecisionReason'
```

**Expected output:** A reproduced network-backed run showed:

```text
deny
pkgxray blocked this install:
  • npm:lodash@4.17.11 → block
      - [known-vulnerability] A vulnerability database reports this package/version as affected. Block before source scanning or installation. (VULNERABILITY_INTELLIGENCE)
Re-run `pkgxray guard <ref>` for the full report
```

The number of repeated vulnerability bullets and current advisory records may
vary.

**Screen sequence:** Show “agent proposes `npm install`,” the exact JSON event,
the guard invocation, then the `deny` decision and first vulnerability reason.
End on “install command never ran.”

**Voiceover / captions:** “The coding agent proposes an install. hookshot sends
the command to the pkgxray guard before execution. OSV reports this pinned
Lodash version as affected, so the hook returns deny and the install does not
run.”

**Blur or exclude:** Replace the hookshot checkout with
`/path/to/hookshot`. Exclude host settings, usernames, tokens, package-manager
configuration, and quarantine locations.

**Reproduction:** `docs/demo/setup.sh` builds `pkgxray-guard` from
`examples/pkgxray-guard` inside the external hookshot checkout. The exact event
and output filter match `docs/demo/still-hookshot.tape` and
`docs/screenshots/README.md`.

**Disclaimer:** The hookshot integration is **Experimental** and depends on an
**external project's hook ABI**; it may change or be removed without a major
pkgxray bump. Treat it as defense in depth, not a sandbox. This known-vulnerable
package demo is network-dependent, and a static clear still cannot prove safety
or catch every later-stage payload.

## 9. Lockfile CI scan

**Purpose and timing:** Demonstrate deterministic CI failure semantics on a
small generated lockfile.

**Exact terminal commands**

```bash
docs/demo/setup.sh
pkgxray audit /tmp/pkgxray-demo/package-lock.json
rc=$?; printf 'exit code: %s\n' "$rc"
```

A minimal GitHub Actions step uses the same command shape:

```yaml
- run: npx pkgxray audit package-lock.json
```

**Expected output:** A reproduced run returned:

```text
Lockfile: `/tmp/pkgxray-demo/package-lock.json` (npm)
Total deps: 2
Decision: **BLOCK**
safe: 1  ·  review: 0  ·  block: 1
Blocked packages:
- **lodash@4.17.11**
exit code: 2
```

Scan time and advisory IDs vary with the network and OSV.

**Screen sequence:** Show the generated lockfile's two package names, run one
audit command, highlight the 1/0/1 summary, the blocked pin, and exit `2`.
Optionally finish with the one-line workflow step.

**Voiceover / captions:** “`pkgxray audit` parses npm, Yarn, pnpm, or package
manifests and batch-checks pinned dependencies. This two-package fixture finds
the vulnerable Lodash pin and exits two, so an ordinary CI step fails.”

**Blur or exclude:** Exclude resolved registry URLs, runner account names,
tokens, full workspace paths, and scan timings. Keep the package version and
exit code visible.

**Reproduction:** `docs/demo/setup.sh` creates the lockfile with
`express@4.21.0` and `lodash@4.17.11`; no `npm install` is required. Re-run
against current OSV data.

**Disclaimer:** Advisory data can change and this fixture demonstrates a known
vulnerability lookup, not every static heuristic. Use pkgxray alongside
`npm audit` or OSV-Scanner, not as a replacement. A clean lockfile scan cannot
prove package safety or inspect a later-downloaded payload.

## 10. Scheduled verdict recheck

**Purpose and timing:** Accurately show how to establish a reviewed baseline and
schedule future drift checks without presenting an unchanged run as a detected
regression.

**Exact terminal commands**

First, on the reviewed project and current lockfile, create human decisions and
fresh verdict timestamps:

```bash
pkgxray triage package-lock.json --include-safe
git add .pkgxray.lock
git commit -m "Record reviewed pkgxray baseline"
```

The triage UI uses `a` to allow, `b` to block, and `s` to skip. Review every
entry; do not mechanically allow a flagged package. Then test the monitoring
command without rewriting the committed baseline:

```bash
pkgxray recheck package-lock.json --no-write --no-version-drift --verbose
rc=$?; printf 'exit code: %s\n' "$rc"
```

Schedule the same comparison:

```yaml
name: pkgxray recheck
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:
jobs:
  recheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npx pkgxray recheck package-lock.json --no-write --format json
```

**Expected output classes and exit codes:** A same-day run against a fresh
baseline will normally classify successfully rescanned dependencies as
`unchanged`; that only validates setup and **does not demonstrate a
regression**. Real future runs can report:

```text
unchanged    fresh verdict equals the stored baseline
improved     fresh verdict is better than the stored baseline
no-baseline  no trusted fresh baseline exists
unknown      the dependency could not be re-evaluated
regressed    fresh verdict is worse than the stored baseline
```

Exit `0` means no verdict regression; exit `3` means at least one dependency
regressed to `REVIEW`; exit `2` means at least one dependency regressed to
`BLOCK`. A package already at `BLOCK` in the baseline and still at `BLOCK` is
unchanged, not a new regression. Newer-version vetting is informational by
default and does not change the exit code unless
`--fail-on-available-updates` is supplied.

**Screen sequence:** 0–15 s explain the committed `.pkgxray.lock` baseline;
15–30 s show deliberate triage choices; 30–45 s show a clean setup check labeled
“UNCHANGED — NOT A REGRESSION DEMO”; 45–60 s show the scheduled workflow and an
exit-code legend rather than fabricating drift output.

**Voiceover / captions:** “Monitoring needs a trusted comparison point. Review
the current lockfile, commit the generated baseline, and schedule recheck.
Today's unchanged result only proves the baseline and command work. If current
intelligence later moves a dependency from safe to review, exit three fails CI;
a move to block returns two.”

**Blur or exclude:** Never show `.pkgxray.lock` reasons that contain internal
ticket URLs or names. Exclude repository secrets, CI tokens, private cache URLs,
home paths, and quarantine paths.

**Reproduction:** Use a disposable test repository first. Keep the reviewed
`.pkgxray.lock` in version control so scheduled runners have the same baseline.
`--no-write` prevents a monitoring run from replacing the evidence it is
comparing against. Remove `--no-version-drift` in production if newer-version
pre-vetting is desired.

**Disclaimer:** Do not stage a fake clean-to-block transition as current threat
intelligence. The meaningful demonstration is baseline setup plus accurate
classification and exit-code semantics; a real regression can only be shown
when intelligence or analysis actually changes. Recheck remains static and
network-backed: it cannot prove safety or see a later-stage payload absent from
the package bytes.
