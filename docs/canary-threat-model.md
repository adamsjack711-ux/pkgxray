# `pkgxray canary` — threat model

Everything else pkgxray does is **static**: it quarantines and inspects bytes,
and never runs what it inspects. `canary` is the one deliberate exception — it
**executes** a package's install-time lifecycle scripts (`preinstall`,
`install`, `postinstall`) to observe what they actually *do*. That turns a
static "this code *could* read `~/.aws/credentials` and POST it somewhere" into
a behavioral "this install *did* read the decoy AWS key and *did* try to send it
to `<host>`."

Because it runs untrusted code, it is opt-in at every entry point
(`--yes-run-untrusted-code` / `PKGXRAY_ALLOW_EXECUTION=1`) and its guarantees —
and their limits — are stated here rather than implied.

## The governing principle: asymmetric evidence

**A canary run can CONFIRM malice. It can never CLEAR a package.**

A `safe` canary verdict means *"nothing malicious was observed in this run"* —
**not** "this package is safe." Sandbox-aware malware stays dormant when it
detects analysis and fires only on a real target. So:

- a `block`/`review` from canary is **strong, behavioral** evidence — act on it;
- a `safe` from canary is **not** a clearance — the **static** scan remains
  authoritative.

The result object carries `confirmsButCannotClear: true` and a `caveat` spelling
this out. Never wire a green canary into an auto-promote path.

## Controls (defense in depth)

| Control | What it does |
|---|---|
| **Opt-in gate** | Refuses to execute without explicit `allowExecution` / `--yes-run-untrusted-code` / `PKGXRAY_ALLOW_EXECUTION=1`. |
| **Scrubbed env** | The child gets an allowlist-built environment (PATH, HOME, TMPDIR, npm cache, proxy vars) — **no inherited secrets**. Real `HOME` is never exposed. |
| **Decoy HOME + honeytokens** | A throwaway HOME seeded with realistic decoy `~/.aws/credentials`, `.npmrc`, `.ssh/id_rsa`, `.env`, `.claude.json`, MCP config — each carrying a **unique random token with no `canary`/`pkgxray` marker on disk**, so a payload grepping file *contents* for a tell can't skip them. Tokens live only in an in-memory map for attribution. |
| **Non-forwarding capture proxy** | All `HTTP(S)_PROXY`/`ALL_PROXY` vars point at a loopback proxy that records requests and **forwards nothing**. Plaintext bodies are read in full and scanned for tokens; HTTPS `CONNECT` records the destination host and refuses the tunnel (`502`). Decoy tokens are therefore safe even when the payload "sends" them. |
| **Process-group kill + egress grace** | The child leads its own process group, so a timeout `SIGKILL`s the **whole group** (backgrounded `(sleep 5; curl…) &` grandchildren included). The proxy stays up for a short grace window after the runner settles so a delayed beacon is still captured, not missed. |
| **OS sandbox isolation** | If the platform ships one, the child is wrapped: `bwrap` (Linux) binds the sandbox root rw / everything else ro, unshares pid+ipc+uts, `--die-with-parent`, `--new-session`; `sandbox-exec` (macOS) denies writes outside the sandbox root. Net stays reachable *only* so loopback→proxy works. |
| **`--require-sandbox` (fail closed)** | Refuses to run at all when no OS sandbox wrapper is available, instead of falling back to env-only isolation. For security-conscious operators who won't accept FS confinement weaker than `bwrap`/`sandbox-exec`. |

### Isolation levels

`result.isolation` reports what was actually achieved:

| Level | FS confinement | How to get it |
|---|---|---|
| `bwrap` | writes confined to sandbox root; pid/ipc/uts isolated; dies with parent | Linux with `bubblewrap` installed |
| `sandbox-exec` | writes outside the sandbox root denied | macOS (built in) |
| `env-only` | **no OS FS confinement** — decoy HOME + scrubbed env + capture proxy only | fallback when neither is present |

At `env-only`, a payload can still write anywhere the running user can. Use
`--require-sandbox` to forbid this fallback.

## In scope — what canary is designed to catch

- **Credential exfiltration (proven):** a decoy token read from the sandbox HOME
  and transmitted over plaintext HTTP, or appearing in an HTTPS `CONNECT`
  authority/URL → `behavioral-exfil` (high). This is *observed*, not inferred.
- **Callback/exfil contact:** an install that phones a known callback host
  (webhook.site, pastebin, oast/interact.sh, ngrok, discord/slack webhooks, …)
  or a raw IP → `behavioral-network` (high).
- **Any install-time egress:** outbound requests to other hosts → `review`.
- **Decoy access:** a decoy credential whose access-time advanced during the run
  → `behavioral-credential-read` (medium, corroborating — atime is unreliable).

## Out of scope — residual risk (stated, not hidden)

These are **real limitations**; `result.limits` repeats them on every run.

- **HTTPS request bodies** are not inspected (no MITM) — only the `CONNECT`
  destination host is recorded. A token exfiltrated inside an HTTPS body is
  caught as *"phoned `<host>` after reading a decoy,"* not as a proven token
  leak. *(Future: optional TLS termination with an ephemeral CA — see below.)*
- **Raw-socket / `dgram` / non-proxied egress** is not seen by an HTTP proxy.
  At `bwrap`/`env-only` the network namespace is shared, so such traffic can
  leave uncaptured. *(Future: a loopback-only network namespace.)*
- **Sandbox-aware / dormant malware** evades observation by fingerprinting
  **(1) environment** (a set `HTTP(S)_PROXY`, a HOME under `/tmp`, decoy-shaped
  dotfiles, missing shell/browser history, VM/CI hostnames), **(2) time**
  (delayed / date-gated activation outlasting the scan window), **(3) geo/locale**
  (only firing in a target region — the node-ipc shape), **(4) network** (a C2
  that is offline/benign during the scan), **(5) interaction** (waiting for real
  developer/runtime signals the install phase never produces). This is the
  fundamental reason a quiet canary is not a clearance.
- **Sandbox escape.** `bwrap`/`sandbox-exec` reduce, but do not eliminate,
  kernel/wrapper-level escape risk. Treat the host as potentially exposed.
- **Only lifecycle scripts run.** Malice that triggers on `require()`/import or
  first real use — not at install — won't fire during a canary run.

## Operational guidance

- **Run canary on a disposable host** (an ephemeral CI runner or throwaway VM),
  **never on a developer machine holding real credentials.** Even with every
  control, you are executing untrusted code.
- **Pass `--require-sandbox`** in any automated use so a missing `bwrap`/
  `sandbox-exec` fails the run instead of silently degrading to `env-only`.
- **Assume network egress may occur.** Run behind an egress-restricted network
  if the environment allows it; the capture proxy blocks *proxied* egress but
  cannot block raw sockets at `env-only`.
- **Read canary as a positive-only signal.** Gate on `block`/`review`; treat
  `safe` as "not caught here," and keep the static verdict as the decision of
  record.

## Flags

```
pkgxray canary <ref> --yes-run-untrusted-code   # required opt-in
                     --require-sandbox           # fail closed without bwrap/sandbox-exec
                     --timeout <ms>              # per-run kill deadline (default 20000)
                     --keep-sandbox              # keep the throwaway root for inspection
                     --format json|markdown
```

## Planned hardening

- **TLS termination** with a per-run ephemeral CA injected via
  `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`, so a token exfiltrated inside an HTTPS
  body is provable (not just "phoned a host").
- **Loopback-only network namespace** (`--unshare-net` with the capture proxy
  reachable inside it), so *all* non-proxied egress is blocked by having no
  route out — closing the raw-socket gap.

Until those land, the limits above are authoritative: **absence of a finding is
not evidence of safety.**
