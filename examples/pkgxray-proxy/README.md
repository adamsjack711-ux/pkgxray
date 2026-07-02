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
  crashed scan can't take down the proxy, and CLI upgrades don't break it.
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

1. **Denylist** match → `403` (never scanned, never cached).
2. **Allowlist** match → stream the tarball (never scanned) — so a false
   positive can't wedge a whole team's CI; pin the package and move on.
3. **Verdict cache** hit for `name@version` → serve the cached decision.
4. **Cache miss** → run `pkgxray guard npm:<name>@<version> --format json`:
   - `safe`/`allow` → stream the real tarball, cache `allow`.
   - `block` → `403` with a JSON body of findings, cache `block`.
   - `review` → follow `reviewPolicy` (below), cache `review`.
5. **Scan error / timeout** → follow `scanErrorPolicy`. The error is **never**
   cached as a verdict.

Every served/blocked tarball response carries:

- `x-pkgxray-verdict: allow | block | review | scan-error`
- `x-pkgxray-source: allowlist | denylist | cache | scan`

## Install & run

```bash
git clone <this-repo> pkgxray-proxy
cd pkgxray-proxy
node bin/proxy.js
```

You'll need the `pkgxray` CLI on `PATH` (or set `pkgxrayBin`):

```bash
npm i -g pkgxray
```

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
| `scanErrorPolicy` | `PKGXRAY_PROXY_SCAN_ERROR_POLICY` | `fail-closed` | `fail-closed` (block) \| `fail-open` (serve). |
| `allowlist` | `PKGXRAY_PROXY_ALLOWLIST` | `[]` | Comma-separated in env. `name` or `name@version`. |
| `denylist` | `PKGXRAY_PROXY_DENYLIST` | `[]` | Comma-separated in env. `name` or `name@version`. |
| `verdictStorePath` | `PKGXRAY_PROXY_VERDICT_STORE` | `~/.pkgxray-proxy/verdicts.json` | File-backed cache. |
| `cacheUrl` | `PKGXRAY_CACHE_URL` | — | Forwarded to the CLI's env; a shared pkgxray cache server collapses repeated fetches. |
| `logDecisions` | `PKGXRAY_PROXY_LOG_DECISIONS` | `true` | Structured JSON decision logs to stdout. |

`reviewPolicy` — what to do with a `review` verdict:
- `block` — treat like `block` (`403`).
- `warn` — **serve** the tarball but annotate the response (default).
- `allow` — serve silently.

`scanErrorPolicy` — what to do when a scan errors or times out:
- `fail-closed` — **block** (`403`). Safer default.
- `fail-open` — serve with `x-pkgxray-verdict: scan-error`. Keeps CI moving at
  the cost of an unscanned package.

### Example config file

```json
{
  "port": 4873,
  "upstream": "https://registry.npmjs.org",
  "reviewPolicy": "block",
  "scanErrorPolicy": "fail-closed",
  "allowlist": ["@myorg/internal", "some-fp-package@1.4.2"],
  "denylist": ["known-bad-pkg"],
  "cacheUrl": "http://pkgxray-cache.internal:7000"
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

**In scope:** gating tarballs, verdict caching, allow/denylists, review &
fail-mode policy, transparent metadata passthrough.

**Out of scope (by design):**
- Rewriting tarball URLs inside metadata responses (see the assumption above).
- Auth/tokens for private registries — planned for v2.
- Post-install / runtime-fetched payloads — that's pkgxray's stated blind spot
  and isn't solvable at the proxy layer. Pair the proxy with runtime sandboxing.

## License

MIT
