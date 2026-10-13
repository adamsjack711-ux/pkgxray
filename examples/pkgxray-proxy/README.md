# pkgxray-proxy

A **scanning pull-through npm registry** that sits between developers/CI and the
upstream registry and gates package tarballs through
[`pkgxray`](https://www.npmjs.com/package/pkgxray) before serving them.

It's the org-level version of the pkgxray install-gate: machines share a proxy's
artifact-bound approvals. New archives remain in private staging until approved;
the default policy withholds reviews, blocks and failed scans. Approval means the
required checks passed under policy, not proof that arbitrary code is harmless.

- **Zero runtime dependencies** — Node ≥18 built-ins only (`node:http`,
  `node:https`, `node:child_process`, `node:fs`).
- **Process-isolated scanning** — shells out to the `pkgxray` CLI, so a hung or
  crashed scan is rejected; the CLI must match the proxy's scanner build.
- **Verdict caching** — fresh approvals for identical bytes, scanner and policy
  avoid rescanning. Separate deny-only holds make repeated refusals fast without
  releasing bytes. Both persist across restarts.
- **Shared, bounded scans** — simultaneous requests for the same artifact and
  policy share one scan. Four scans run concurrently by default; cached decisions
  bypass the queue. Each request still downloads and hashes its own snapshot.
- **Policy is configuration** — fail-mode, review handling, and allow/denylists
  are all config, not code.

## How it works

For each request the proxy inspects the path:

| Request | Example | Behavior |
|---|---|---|
| **Metadata** (packument / version) | `GET /lodash` | Passed through to upstream, streamed back **unchanged**. |
| **Tarball** | `GET /lodash/-/lodash-4.17.21.tgz` | Runs through **the gate** (below). |
| Other (search, user, etc.) | `GET /-/v1/search` | Passed through. |

The gate, in order:

1. Denylisted packages return `403`.
2. Download the canonical tarball into a private temporary file (64 MiB / 30 second limits), computing SHA-256. Client range and conditional headers are excluded; partial, redirected and encoded responses are rejected.
3. Reuse a fresh, matching deny-only hold to refuse delivery, or a bound approval to release the archive. Artifact digest, scanner build and policy context must match. Legacy name/version cache entries cannot authorize delivery. Both cache paths bypass the scan queue.
4. Otherwise join an identical in-flight scan or queue a bounded scan using `pkgxray guard npm:<name>@<version> --archive <snapshot> --integrity <SRI> --receipt-only --format json`. The scanner verifies integrity and the archive's manifest identity before analysis. Queue overflow or expiry refuses delivery; it never authorizes a package.
5. Require a matching receipt with completed source and vulnerability checks. A block, scan failure, missing receipt or incomplete scan returns `403`. A complete review is also withheld by default; explicit `reviewPolicy` overrides can permit discretionary reviews. Persist the approval or a separate deny-only hold.
6. Serve the held snapshot and remove it after the response. No second upstream fetch occurs after approval.

Served responses carry `x-pkgxray-verdict`, `x-pkgxray-source` and `x-pkgxray-sha256`. Block responses include the reason. Name-only `allowlist` entries no longer bypass scanning; use the shared policy's digest-pinned exceptions when appropriate.

Receipts are local records from a trusted child process, not signed attestations. The proxy and configured CLI must use the same source build. Updating the CLI independently causes receipt rejection until both are updated. Source or vulnerability checks that are disabled, skipped or incomplete cannot authorize delivery. This receipt does not certify transitive dependencies or runtime behavior.

## Install & run

```bash
git clone <this-repo> pkgxray-proxy
cd pkgxray-proxy
node bin/proxy.js
```

Use the CLI from the same checkout as this proxy (or an identically built installation):

```bash
PKGXRAY_BIN=../../bin/audit.js node bin/proxy.js
```

Run this from `examples/pkgxray-proxy`; a separately installed release may have a different build fingerprint.

The proxy prints the exact `.npmrc` line on startup.

## Point npm at the proxy

Add to your project (or user) `.npmrc`:

```ini
registry=http://127.0.0.1:4873
```

or for a single command:

```bash
npm install --registry http://127.0.0.1:4873
```

Now `npm install` pulls metadata straight through, but tarballs requested through
this proxy stay quarantined until a scan or valid cached approval authorizes
delivery. Other project work and metadata requests can continue while scans run;
first-time installation of a new dependency must wait for its decision.

This controls requests routed through the proxy. Existing npm caches, lockfiles
with other registry URLs, direct downloads and other package managers can bypass
it. Use `pkgxray install` for the supported npm lockfile workflow that verifies
every installed artifact and disables lifecycle scripts; enforced routing also
requires controls on the runner/network. Temporary snapshots are deleted after
each response, including refusals; quarantine is not a persistent review inbox.

## Configuration

Config is merged with the precedence **defaults ← config file ← environment**.
Point `PKGXRAY_PROXY_CONFIG` at a JSON file for the file layer.

| Field | Env var | Default | Notes |
|---|---|---|---|
| `port` | `PKGXRAY_PROXY_PORT` | `4873` | `0` = random free port. |
| `host` | `PKGXRAY_PROXY_HOST` | `127.0.0.1` | Bind `0.0.0.0` to share across a network. |
| `upstream` | `PKGXRAY_PROXY_UPSTREAM` | `https://registry.npmjs.org` | The real registry. |
| `pkgxrayBin` | `PKGXRAY_BIN` | `pkgxray` | Path/name of the CLI. |
| `scanTimeoutMs` | `PKGXRAY_PROXY_SCAN_TIMEOUT_MS` | `20000` | The child is SIGKILL'd past this. |
| `scanConcurrency` | `PKGXRAY_PROXY_SCAN_CONCURRENCY` | `4` | Concurrent artifact scans, from 1 to 32. |
| `maxPendingScans` | `PKGXRAY_PROXY_MAX_PENDING_SCANS` | `64` | Queued distinct artifact scans, from 0 to 1024; overflow refuses delivery. |
| `reviewPolicy` | `PKGXRAY_PROXY_REVIEW_POLICY` | `block` | `block` \| `warn` \| `allow`. |
| `scanErrorPolicy` | `PKGXRAY_PROXY_SCAN_ERROR_POLICY` | `fail-closed` | Legacy diagnostic setting; artifact delivery always fails closed. |
| `allowlist` | `PKGXRAY_PROXY_ALLOWLIST` | `[]` | Legacy diagnostic setting; cannot bypass artifact verification. |
| `denylist` | `PKGXRAY_PROXY_DENYLIST` | `[]` | Legacy diagnostic setting; cannot bypass artifact verification. |
| `verdictStorePath` | `PKGXRAY_PROXY_VERDICT_STORE` | `~/.pkgxray-proxy/verdicts.json` | File-backed cache. |
| `verdictTtlMs` | `PKGXRAY_PROXY_VERDICT_TTL_MS` | `86400000` (24h) | A cached verdict older than this is re-scanned on the next request. `0` = always re-scan. |
| `holdTtlMs` | `PKGXRAY_PROXY_HOLD_TTL_MS` | `300000` (5m) | Reuse a block, strict review or incomplete/unbound result only to deny delivery. `0` disables hold reuse. |
| `scanErrorTtlMs` | `PKGXRAY_PROXY_SCAN_ERROR_TTL_MS` | `60000` (1m) | Denial-only retry delay after scanner errors/timeouts. `0` retries immediately. Queue pressure is never cached. |
| `cacheUrl` | `PKGXRAY_CACHE_URL` | — | Forwarded to the CLI's env; a shared pkgxray cache server collapses repeated fetches. |
| `logDecisions` | `PKGXRAY_PROXY_LOG_DECISIONS` | `true` | Structured JSON decision logs to stdout. |

`reviewPolicy` — what to do with a `review` verdict:
- `block` — withhold the archive (`403`, default); resolve the reported findings before retrying.
- `warn` — **serve** the tarball but annotate the response (explicit opt-in).
- `allow` — serve silently.

Artifact delivery always fails closed on errors, including failed refreshes. `scanErrorPolicy` remains available to legacy diagnostic helpers, but cannot authorize unverified bytes.

Queued scans may wait at most `scanTimeoutMs` before refusal. Once started, the
scanner has its own `scanTimeoutMs` execution deadline. Failed work is removed
from the in-flight map; scanner failures use the bounded retry delay below. These limits bound scanner
work; they do not replace server-wide connection or download quotas.

`verdictTtlMs` limits approval age (24 hours by default; zero forces a scan on every request). Byte, policy and build changes invalidate approval immediately. Advisory changes become visible on refresh; there is no live revocation feed. An upstream download is required even on a verdict cache hit so changed bytes are detected.

Changed packages scan independently; unaffected approvals remain reusable.

Holds preserve findings but cannot grant execution, including under `reviewPolicy: warn` or `allow`. They expire after `holdTtlMs`; scanner errors expire after `scanErrorTtlMs`. Both lifetimes are capped by `verdictTtlMs`, so its zero setting still forces every request to scan. Expiry triggers a scan on the next request; it does not release the hold automatically. Changed bytes, package identity, scanner build, policy, upstream, scanner path or scan timeout invalidate reuse. A new denial retires any prior approval for that package version.

This implements package-level reuse in the registry proxy. It does not add file-level incremental analysis, background revalidation, a persistent quarantine inbox, or caching to `pkgxray install`. Runtime MCP call checks remain separate from package scans.

### Force a refresh — `POST /-/pkgxray/recheck`

After a big advisory drop you don't have to wait for the TTL. An admin `POST` to
`/-/pkgxray/recheck` re-scans **every** cached `name@version` and updates the
store in place, including held packages, returning a JSON summary. These name/version rechecks do not mint artifact approvals: a successful recheck clears the prior hold or approval binding, so the next tarball request scans its snapshot again. Failed rechecks preserve the previous record and its original expiry:

```bash
curl -X POST http://127.0.0.1:4873/-/pkgxray/recheck
# { "ok": true, "total": 128, "changed": [ { "name": "x", "version": "1.2.3",
#   "from": "allow", "to": "block" } ], "unchanged": 126, "errors": [] }
```

`GET` on that path is `405` (POST-only, so a crawler can't trigger a full
re-scan). A verdict that regresses on refresh flips subsequent decisions to
`block`/`review`; a re-scan that errors is reported under `errors` and leaves the
prior good verdict untouched.

**Authorization.** Because a recheck re-scans *every* cached package — one
download + extract + scan each — the endpoint is guarded so a remote caller
can't use it to amplify load:

- With no `adminToken` set (the default), the endpoint accepts **loopback
  clients only**. The `curl http://127.0.0.1:...` above works; a request from
  any other host gets `403`.
- Set `adminToken` (config file) or `PKGXRAY_PROXY_ADMIN_TOKEN` (env) to require
  a shared secret, which lets a trusted admin trigger a recheck remotely:

  ```bash
  curl -X POST -H "Authorization: Bearer $TOKEN" \
    http://pkgxray-proxy.internal:4873/-/pkgxray/recheck
  ```

  A missing or wrong token is `401` (compared in constant time). The
  `x-pkgxray-admin-token: <token>` header is accepted as an alternative to
  `Authorization: Bearer`.

When you bind the proxy to a non-loopback address (see **Deployment**), set an
`adminToken` — otherwise every recheck must originate from the proxy host
itself.

### Example config file

```json
{
  "port": 4873,
  "upstream": "https://registry.npmjs.org",
  "reviewPolicy": "block",
  "scanErrorPolicy": "fail-closed",
  "allowlist": ["@myorg/internal", "some-fp-package@1.4.2"],
  "denylist": ["known-bad-pkg"],
  "cacheUrl": "http://pkgxray-cache.internal:7000",
  "adminToken": "set-a-long-random-secret-to-allow-remote-recheck"
}
```

```bash
PKGXRAY_PROXY_CONFIG=/etc/pkgxray-proxy.json node bin/proxy.js
```

## Deployment

Run it as a service (systemd, launchd, a container) on a host your developers and
CI can reach, bind `host: 0.0.0.0`, and hand out the `registry=` line via a
committed `.npmrc`. Put a shared `pkgxray` cache server behind `cacheUrl` so
repeated upstream fetches during scanning are collapsed across the fleet.

When you bind to a non-loopback address, set an `adminToken` (see the recheck
endpoint above) so the state-changing recheck can't be triggered by any client
that can reach the port. The proxy is otherwise a read-through gate and, like
the cache server, is **not** an auth boundary — run it inside a trusted network
or behind your own authenticating reverse proxy.

**Tarball URL assumption:** the proxy does **not** rewrite the `dist.tarball`
URLs inside metadata responses. It assumes those URLs resolve back through the
proxy — which is the case when clients point their `registry` at the proxy and
the upstream returns registry-relative-style absolute URLs on the same host they
requested. If your upstream hard-codes `registry.npmjs.org` tarball URLs that
bypass the proxy, front it accordingly (or add URL rewriting — out of scope
here).

## Testing

```bash
node --test                 # unit + in-process server tests, no network, no pkgxray needed
PKGXRAY_PROXY_E2E=1 node --test   # also run the opt-in test against the real registry
```

The gate logic is unit-tested with a **mocked** pkgxray runner, so the suite
never hits the network or requires `pkgxray` to be installed.

## Scope

**In scope:** exact-byte gating on canonical tarball routes, context-bound verdict caching, denylisting, review policy and transparent metadata passthrough.

**Out of scope (by design):**
- Rewriting tarball URLs inside metadata responses (see the assumption above).
- Auth/tokens for private registries — planned for v2.
- Post-install / runtime-fetched payloads — that's pkgxray's stated blind spot
  and isn't solvable at the proxy layer. Pair the proxy with runtime sandboxing.

## License

MIT
