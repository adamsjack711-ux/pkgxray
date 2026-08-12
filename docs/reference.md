# pkgxray reference

Detailed reference material split out of the [README](../README.md) to keep the
landing page focused. Covers the severity policy, `recheck` monitoring,
performance numbers, JSON output shapes, the browser extension, and the
self-hostable cache server. For the compatibility contract and stability tiers,
see [compatibility.md](compatibility.md).

---

## Severity policy (what lands in block / review / info)

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

Exit codes key off the worst *regression*: `0` nothing regressed, `2`
regressed to **block**, `3` regressed to **review**. A dep that was already
`block` at install is not a new regression. Set `PKGXRAY_CACHE_URL` so a large
tree shares `guard`'s warm cache.

**Version drift** — `recheck` also asks the registry whether a **newer
version** exists and guards it, so you see the verdict *before* upgrading.
This is informational (never changes the exit code) unless you pass
`--fail-on-available-updates`; `--no-version-drift` skips the registry pass.

### Scheduled CI job (GitHub Actions)

See the [GitHub Actions integration](integrations/github-actions.md) for
copy-paste pull-request and scheduled workflows with minimal permissions,
full-SHA action pins, an exact pkgxray version, JSON output, and explicit exit
code handling.

---

## Performance

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

All JSON carries `schemaVersion: 1`; within `0.x` fields are additive only. Run
any command with `--format json`. Top-level fields:

- **audit / `--file`** — `verdict`, `grade`, `score`, `parameters`, `summary`,
  `riskBands[]`, `findings[]`
- **guard** — `decision`, `resolved`, `githubMetadata`, `npmVsGithubDiff`,
  `vulnerabilityPrecheck`, `timings`, `quarantinePath`, `promotedPath`, `report`
- **audit `<lockfile>`** — `file`, `format`, `totalDeps`, `uniqueDeps`,
  `summary`, `worstDecision`, `results[]`

---

## Browser extension

`browser-extension/` is a Chrome-compatible Manifest V3 unpacked extension that
runs entirely locally and requests no browser permissions. Load it via
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
