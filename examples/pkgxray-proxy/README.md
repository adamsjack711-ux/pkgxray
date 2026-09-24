# pkgxray-proxy

A **scanning pull-through npm registry** that sits between developers/CI and the
upstream registry and gates package tarballs through
[`pkgxray`](https://www.npmjs.com/package/pkgxray) before serving them.

It's the org-level version of the pkgxray install-gate: instead of every machine
scanning on install, one proxy scans a package **once**, caches the verdict, and
blocks known-malicious or vulnerable tarballs from ever reaching a developer's
machine.

- **Zero runtime dependencies** — Node ≥18 built-ins only (`node:http`,
  `node:https`, `node:child_process`, `node:fs`).
- **Process-isolated scanning** — shells out to the `pkgxray` CLI, so a hung or
  crashed scan is rejected; the CLI must match the proxy's scanner build.
- **Verdict caching** — the first requester of a package pays the scan cost;
  everyone else hits the cache. Verdicts persist across restarts.
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
3. Reuse a fresh verdict only if its artifact digest, scanner build and policy context match. Legacy name/version cache entries cannot authorize delivery.
4. Otherwise run `pkgxray guard npm:<name>@<version> --archive <snapshot> --integrity <SRI> --receipt-only --format json`. The scanner verifies integrity and the archive's manifest identity before analysis.
5. Require a matching receipt with completed source and vulnerability checks. A block, scan failure, missing receipt or incomplete scan returns `403`. A complete review follows `reviewPolicy`.
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

Now `npm install` pulls metadata straight through, but every tarball is scanned
(once) and gated before it lands on disk.

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
| `reviewPolicy` | `PKGXRAY_PROXY_REVIEW_POLICY` | `warn` | `block` \| `warn` \| `allow`. |
| `scanErrorPolicy` | `PKGXRAY_PROXY_SCAN_ERROR_POLICY` | `fail-closed` | Legacy diagnostic setting; artifact delivery always fails closed. |
| `allowlist` | `PKGXRAY_PROXY_ALLOWLIST` | `[]` | Legacy diagnostic setting; cannot bypass artifact verification. |
| `denylist` | `PKGXRAY_PROXY_DENYLIST` | `[]` | Legacy diagnostic setting; cannot bypass artifact verification. |
| `verdictStorePath` | `PKGXRAY_PROXY_VERDICT_STORE` | `~/.pkgxray-proxy/verdicts.json` | File-backed cache. |
| `verdictTtlMs` | `PKGXRAY_PROXY_VERDICT_TTL_MS` | `86400000` (24h) | A cached verdict older than this is re-scanned on the next request. `0` = always re-scan. |
| `cacheUrl` | `PKGXRAY_CACHE_URL` | — | Forwarded to the CLI's env; a shared pkgxray cache server collapses repeated fetches. |
| `logDecisions` | `PKGXRAY_PROXY_LOG_DECISIONS` | `true` | Structured JSON decision logs to stdout. |

`reviewPolicy` — what to do with a `review` verdict:
- `block` — treat like `block` (`403`).
- `warn` — **serve** the tarball but annotate the response (default).
- `allow` — serve silently.

Artifact delivery always fails closed on errors, including failed refreshes. `scanErrorPolicy` remains available to legacy diagnostic helpers, but cannot authorize unverified bytes.

`verdictTtlMs` limits approval age (24 hours by default; zero forces a scan on every request). Byte, policy and build changes invalidate approval immediately. Advisory changes become visible on refresh; there is no live revocation feed. An upstream download is required even on a verdict cache hit so changed bytes are detected.

### Force a refresh — `POST /-/pkgxray/recheck`

After a big advisory drop you don't have to wait for the TTL. An admin `POST` to
`/-/pkgxray/recheck` re-scans **every** cached `name@version` and updates the
store in place, returning a JSON summary. These name/version rechecks do not mint artifact approvals: a successful recheck invalidates the prior binding, so the next tarball request scans its snapshot again:

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
