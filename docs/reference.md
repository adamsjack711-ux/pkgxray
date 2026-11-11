# pkgxray reference

Active commands describe the **unpublished breaking 2.0 candidate**. The 1.3
work remains a separate held PR. The explicitly labeled 1.2.1 example below is
historical. Candidate public gates use binary decisions and exit codes `0`/`2`;
blocked uncertainty is not a claim of confirmed malware.

Detailed reference material split out of the [README](../README.md) to keep the
landing page focused. Covers the severity policy, `recheck` monitoring,
performance numbers, JSON output shapes, the browser extension, and the
self-hostable cache server. For the compatibility contract and stability tiers,
see [compatibility.md](compatibility.md).

---

## Synthetic BLOCK example

This optional walkthrough uses an inert synthetic fixture. It is scanned as
source data only; it is never installed or executed. Download the file from an
immutable commit, then run the published scanner:

```bash
curl --fail --location --output pkgxray-onboarding.json \
  https://raw.githubusercontent.com/adamsjack711-ux/pkgxray/751ff97332650f983fdc39a013dfcec855a8b4de/examples/onboarding-malicious.json
npx --yes pkgxray@1.2.1 --file ./pkgxray-onboarding.json --format markdown
```

Expected exit code: **`2`** (`BLOCK`). The excerpt below is from the published
1.2.1 run:

```text
Verdict: **BLOCK**
- **HIGH credential-access** — Reads a path to a credential / wallet / key store near a filesystem read. (`index.js`)
```

The cited fragments resolve to `/.ssh/id_rsa` beside `fs.readFileSync`. This is
a static finding in a synthetic sample, not an observed exploit or proof that a
real package stole credentials.

---

## Package and project scans

```bash
pkgxray guard npm:some-package@1.2.3 [--format json]   # vet a package before install
pkgxray guard pypi:some-package@1.2.3                  # same, for a PyPI package (sdist staged + scanned)
pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server   # vet an MCP server; --recheck catches the rug-pull
pkgxray audit package-lock.json [--deep-all]               # also: yarn.lock, pnpm-lock.yaml, package.json
pkgxray audit requirements.txt [--deep]                # PyPI: also poetry.lock, Pipfile.lock, pyproject.toml
pkgxray recheck package-lock.json                      # scheduled: non-zero only on a regression
```

`audit` checks resolved dependencies against OSV. `--deep` adds source scans for
blocked dependencies; `--deep-all` requests source scans for all resolved dependencies.
Failed deep scans and incomplete source collection block with coverage reasons.
`guard --deps` includes direct-dependency findings in its decision; only exact pins
are checked, with ranges and other unresolved sources blocked as inconclusive. Guard output
lists completed, partial, disabled and failed checks so a passing verdict does not
imply checks that never ran.
PyPI scans cover source-distribution manifests, vulnerability metadata, and text-level
injection checks; they do not provide full Python module behavioral analysis or wheel inspection.
Python source adds an `unsupported-behavior` uncertainty finding. Behavioral
coverage gaps block and cannot be cleared by muting, a manual choice or a pinned
operator exception. Archives containing links or special files are rejected.

Eligible transient OSV failures retry once for the same resolved identity within
the original shared deadline. No replacement bytes are acquired for that check;
disabled or malformed checks, heuristic findings and permission gaps do not retry.
Persistent uncertainty blocks without a prompt. Review flags and Proceed/Decline
flows are removed. MCP `--force` is rejected, and `--no-scan-results` is removed.
Explicit user-invoked triage policy writes and canary/VM opt-ins remain separate.

Policy configuration is documented in [configuration.md](configuration.md).

## Severity policy (what lands in block / review / info)

The labels below describe raw evidence severity. Internal `review` means
uncertainty; public gates map it to block with reasons. It is neither a pending
user decision nor proof of malware. Explicit digest-pinned declarative policy
may affect discretionary findings, but cannot override mandatory missing checks.

**block** (HIGH). Any one of these:

- prompt-injection text that forces a verdict or overrides rules, in docs *or* in
  a code comment
- a credential read near a filesystem-read primitive. This includes paths built
  from split fragments (`".s"+"sh"`), which a light de-obfuscation pass folds
  back together.
- persistence writes
- execution or outbound network, plus a hardcoded public IP, link shortener, or
  webhook
- a bulk `process.env` harvest in the same file as outbound network. Sinks
  include `sendBeacon`, `EventSource`, `dns.*`, `dgram`, and remote `import()`.
- a dynamic `require` or `import` of a computed name, sitting next to an env
  harvest
- a stage-2 loader that reads an opaque blob and `eval`s it
- a large encoded blob decoded into a **computed-arg** `eval`, `new Function`, or
  `child_process`
- token exfiltration split across files
- **concealed or encoded injection**: instructions smuggled in invisible Unicode
  tag characters, or a base64 blob in docs or comments, that decode to a
  verdict-forcing prompt
- a read of the cloud instance-metadata service or a managed secret store from
  install-time code, or next to an exfiltration sink
- a CI/CD workflow written into the consuming repository by install-time code
- an install-time script that deletes its own file after it fetches or executes a
  payload
- publishing to the package registry from install-time code. This also covers
  code that lists which packages the current credentials can publish to and then
  publishes.

**review** (MEDIUM). Any one of these:

- install or postinstall scripts
- `eval`, `new Function`, or vm on a **computed** argument
- weaker prompt injection: reworded steering, chat or role scaffolding such as
  `<|im_start|>`, `<<SYS>>`, or `[INST]`, and identity reassignment
- a lone dynamic `require` or `import` by computed name
- a lone bulk `process.env` harvest
- a path or domain assembled from split fragments
- Trojan Source Unicode
- **invisible Unicode tag characters**, a channel for smuggling text, even when
  they do not decode to a known prompt
- a destructive operation gated on region or locale
- download-then-execute
- clipboard access
- a lone exfiltration or callback domain
- a cloud-metadata or secret-store read that forwards to a second host from
  ordinary runtime code
- a CI/CD workflow written by a scaffolder you invoked yourself
- self-deletion with no fetch or exec stage
- npm↔GitHub divergence
- a missing package.json or entrypoint

**info**. Recorded as evidence, and does not gate the verdict:

- child_process, fetch, or network in isolation
- `eval` or `new Function` on a **string literal**, such as a bundler
  `eval-source-map` wrapper or a feature-detection probe. The executed text is in
  the artifact, and it is scanned as code.
- a package name that disagrees with its declared repository while a consumer
  install hook is present (`metadata-mimicry`). This is ordinary for monorepos
  and multi-artifact repos, and without publisher data it looks the same as a
  typosquat, so it stays evidence only.

`.d.ts`, `.map`, `.min.js`, `.lock` files are skipped. Tarballs up to 20,000
entries / 256 MB uncompressed are scanned.

---

## Monitoring: `pkgxray recheck`

`guard` and `audit` give a point-in-time verdict *at install*. `recheck`
answers the follow-up: **has anything I already depend on become unsafe since
I installed it?** — the maintainer-takeover / trojaned-update case.

It walks a lockfile, re-runs the guard evaluation for each pinned
`name@version`, and diffs the fresh verdict against the baseline in
`.pkgxray.lock`. It reports a **diff, not a full report**: *regressed*
(verdict got worse — you may be exposed), *improved*, *unchanged* (hidden
unless `--verbose`), and *no-baseline* / *unknown*.

```bash
pkgxray recheck package-lock.json               # human diff
pkgxray recheck package-lock.json --verbose     # also list unchanged deps
pkgxray recheck package-lock.json --no-write    # don't update stored baselines
pkgxray recheck package-lock.json --format json # machine-readable diff
```

Decision exit codes key off the worst *regression*: `0` nothing regressed, `2`
for a blocking regression, including unresolved uncertainty. A dep that was already
`block` at install is not a new regression. Set `PKGXRAY_CACHE_URL` so a large
tree shares `guard`'s warm cache.

**Version drift** — `recheck` also asks the registry whether a **newer
version** exists and guards it, so you see the verdict *before* upgrading.
This is informational (never changes the exit code) unless you pass
`--fail-on-available-updates`; `--no-version-drift` skips the registry pass.
An incomplete candidate check or registry failure appears under **UPDATE CHECK
INCOMPLETE**. A clean same-major candidate does not clear an unscanned latest
release. With `--fail-on-available-updates`, incomplete checks return `2`
with reasons distinguishing missing evidence from observed blocking findings.

Each candidate's JSON includes `securityChanges`, comparing findings against
the fresh scan of the pinned version. This exposes new evidence even when both
versions remain blocked for uncertainty. No additional package scan is needed. Text output shows
new findings; `--verbose` also includes empty or unavailable comparisons.
See [upgrade comparisons](upgrade-comparisons.md) for matching, coverage limits,
and the reproducible regression corpus.

### Scheduled CI job (GitHub Actions)

See the [GitHub Actions integration](integrations/github-actions.md) for
copy-paste pull-request and scheduled workflows with minimal permissions,
full-SHA action pins, an exact pkgxray version, JSON output, and explicit exit
code handling.

---

## Performance

These historical measurements predate the 2.0 candidate; they do not measure
its automatic retries or changed decision contract.

Local static analysis is ~25 ms; almost all of `guard`'s wall-clock is network
round-trips (registry, OSV, GitHub, provenance). Measured on an Apple M1
(Node 26), cold cache:

| Package | Weekly downloads | `guard` time |
|---|--:|--:|
| `is-number@7.0.0` | ~170M | ~1.3 s |
| `express@4.21.0` | ~110M | ~1.4 s |
| `commander@12.1.0` | ~444M | ~1.5 s |
| `chalk@5.3.0` | ~451M | ~1.5 s |

A known-vulnerable package blocks at the OSV precheck, before download. Point CI
at the cache server to collapse repeated GitHub fetches across runners.

`mcp-proxy` runtime overhead (same machine): per-`tools/call` gate decision
p50 ~0.05 µs / p95 ~0.1 µs (in-memory verdict lookup, no IO); full manifest
re-audit ~1 ms per 30 tools, and it runs only when the manifest changes;
result scan ~0.06 ms for a typical 2 KB result, ~13 ms worst-case at the
512 KiB cap.

---

## JSON output

Public decision JSON uses `schemaVersion: 2`; fields remain additive within that
contract. Internal raw reports and configuration/receipt persistence formats
retain their own versions. Use `--format json` where supported. Top-level fields:

- **audit / `--file`** — `verdict`, `grade`, `score`, `parameters`, `summary`,
  `riskBands[]`, `findings[]`
- **guard** — `decision`, `resolved`, `githubMetadata`, `npmVsGithubDiff`,
  `vulnerabilityPrecheck`, `timings`, `quarantinePath`, `promotedPath`, `report`,
  `resolution.reasonCodes`, `resolution.retry`
- **audit `<lockfile>`** — `file`, `format`, `totalDeps`, `uniqueDeps`,
  `summary` (`safe`, `blocked`, `inconclusive`), `worstDecision`, `results[]`,
  `resolution.retry`

`inconclusive` is a subset of blocked results, not a third decision. Retry counts
record additional attempts: guard vulnerability checks have at most one; lockfile
batch counts aggregate across separately bounded chunks. See [JSON schema](json-schema.md).

---

## Browser extension

`browser-extension/` is a Chrome-compatible Manifest V3 unpacked extension that
runs entirely locally and requests no browser permissions. It scans pasted evidence
with engine defaults; it cannot read `.pkgxray.json` or fetch and quarantine packages. Load it via
`chrome://extensions` → Developer Mode → **Load unpacked** → select the folder.

---

## Self-hostable cache server

Every `guard` / `audit --deep` fetches GitHub metadata and tarballs; in CI that
duplicates traffic. Run a shared cache to collapse it into one fetch per
(repo, ref) per TTL window:

```bash
pkgxray-cache --port 8819 --host 0.0.0.0 --cache-dir /var/cache/pkgxray
export PKGXRAY_CACHE_URL=http://cache.internal:8819
```

Routes: `GET /github/repos/{owner}/{repo}` (1h), `GET
/github/tarball/{owner}/{repo}/{ref}` (24h, streamed), `GET /healthz`. With
`PKGXRAY_CACHE_URL` unset, clients run the default path with zero overhead.

The server binds `127.0.0.1` by default; to serve a fleet, opt into a routable
interface with `--host 0.0.0.0` (or `PKGXRAY_CACHE_HOST`) as shown above.

> **Trust model:** the cache is a transparent proxy, **not** an auth boundary —
> no login or rate limit. Run it on a private network or behind a reverse proxy
> that enforces your own auth. Never put it on a public network.


### Exact npm archive scans

`pkgxray guard npm:demo@1.0.0 --archive ./demo.tgz --integrity 'sha512-…' --format json --receipt-only` verifies the supplied compressed archive before extraction, checks the manifest name/version, and scans those bytes without resolving a replacement tarball from the registry. `--receipt-only` omits source contents from JSON; it does not skip analysis. Vulnerability checks still require OSV unless explicitly disabled, and the receipt records disabled checks.

The `approval` record includes `artifactSha256`, `name`, `version`, `scannerBuildId`, `policySha256`, `checks`, `sourceComplete`, `decision` and `issuedAt`. Consumers must validate all required fields and completion states, not merely the presence of a receipt. Receipts are unsigned local records, not remote attestations.

Npm package-lock/shrinkwrap deep scans retain and verify the locked URL and SRI digest. Missing or conflicting identities block with an incomplete-identity reason. Other npm manifest/lock formats currently lack this binding and therefore cannot receive a successful deep artifact approval; their version-based vulnerability audit still works. PyPI deep scans do not yet bind to lockfile artifact hashes.

The example proxy scans and serves the same held archive and requires completed source/vulnerability checks. Use [`pkgxray install`](enforced-install.md) to install a supported npm lockfile from approved local archives. The install hook remains a preflight assessment: it does not force npm to consume an approved snapshot, prevent direct-registry bypasses, or cover install-time downloads. See `examples/pkgxray-proxy/README.md` for enforcement boundaries.
