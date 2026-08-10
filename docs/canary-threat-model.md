# `pkgxray canary` — threat model

Everything else pkgxray does is **static**: it quarantines and inspects bytes,
and never runs what it inspects. `canary` is the one deliberate exception — it
**executes** the package in two phases and observes what it actually *does*:

1. **Install phase** — the declared lifecycle scripts (`preinstall`, `install`,
   `postinstall`), the surface the TeamPCP / node-ipc families use.
2. **Import phase** — loading the package's own entry point (`require`/`import`
   of its `main`), so a package that is benign at install but malicious on first
   `require` — the flatmap-stream shape — is triggered and observed too. Disable
   with `--no-import-phase` to run install-only.

Both phases run inside the **same** sandbox (decoy HOME, capture proxy, OS
wrapper, resource caps, process-group timeout kill). That turns a static "this
code *could* read `~/.aws/credentials` and POST it somewhere" into a behavioral
"this package *did* read the decoy AWS key on import and *did* try to send it to
`<host>`."

Because it runs untrusted code, it is opt-in at every entry point
(`--yes-run-untrusted-code` / `PKGXRAY_ALLOW_EXECUTION=1`) and its guarantees —
and their limits — are stated here rather than implied.

**Import-phase ceiling (stated, not hidden):** the staged package is detonated
*without its dependencies installed*, so if its entry point `require()`s an
uninstalled dependency on the first line, that throws before the payload runs —
the same ceiling any without-install detonation faces. The phase is best-effort:
it triggers and observes side effects, it does not guarantee the module fully
loaded. And on Linux the network namespace is still shared with the host (see
[isolation levels](#isolation-levels)), so the import phase — like the install
phase — relies on the capture proxy rather than an OS network boundary there;
`sandbox-exec` on macOS is the only tier that denies non-loopback egress at the
kernel today.

## The governing principle: asymmetric evidence

**A canary run can CONFIRM malice. It can never CLEAR a package.**

A `not-observed` canary verdict means *"nothing malicious was observed in this
run"* — **not** "this package is safe." The verdict is deliberately named
`not-observed` (never `safe`) so no caller mistakes a quiet run for a clearance.
Sandbox-aware malware stays dormant when it detects analysis and fires only on a
real target. So:

- a `block`/`review` from canary is **strong, behavioral** evidence — act on it;
- a `not-observed` from canary is **not** a clearance — the **static** scan
  remains authoritative.

The result object carries `confirmsButCannotClear: true` and a `caveat` spelling
this out. Never wire a green canary into an auto-promote path.

## Controls (defense in depth)

| Control | What it does |
|---|---|
| **Opt-in gate** | Refuses to execute without explicit `allowExecution` / `--yes-run-untrusted-code` / `PKGXRAY_ALLOW_EXECUTION=1`. |
| **Scrubbed env** | The child gets an allowlist-built environment (PATH, HOME, TMPDIR, npm cache, proxy vars) — **no inherited secrets**. Real `HOME` is never exposed. |
| **Decoy HOME + honeytokens** | A throwaway HOME seeded with realistic decoy `~/.aws/credentials`, `.npmrc`, `.ssh/id_rsa`, `.env`, `.claude.json`, MCP config — each carrying a **unique random token with no `canary`/`pkgxray` marker on disk**, so a payload grepping file *contents* for a tell can't skip them. Tokens live only in an in-memory map for attribution. |
| **Non-forwarding capture proxy** | All `HTTP(S)_PROXY`/`ALL_PROXY` vars point at a loopback proxy that records requests and **forwards nothing**. Plaintext bodies are read in full and scanned for tokens **verbatim or base64/base64url/hex/url-encoded** (a payload that encodes the secret before sending is still attributed to the exact decoy); HTTPS `CONNECT` records the destination host and refuses the tunnel (`502`). Decoy tokens are therefore safe even when the payload "sends" them. Teardown force-closes lingering sockets so a payload holding a keep-alive connection open can't wedge the run. |
| **Process-group kill + egress grace** | The child leads its own process group, so a timeout `SIGKILL`s the **whole group** (backgrounded `(sleep 5; curl…) &` grandchildren included). The proxy stays up for a short grace window after the runner settles so a delayed beacon is still captured, not missed. |
| **Resource caps (`ulimit`)** | On POSIX, the child shell runs under lowered `ulimit`s — CPU seconds (derived from the timeout), single-file write size, max user processes (fork-bomb backstop), and no core dumps — bounding *blast radius* during the window the timeout bounds in *time*. Limits can only be lowered, so a stricter host limit is honored; disable with `rlimits:false`. |
| **OS sandbox isolation** | If the platform ships one, the child is wrapped: `bwrap` (Linux) binds the sandbox root rw / everything else ro, **stacks a tmpfs over the real home dir so the operator's actual `~/.aws`/`~/.ssh`/`~/.npmrc` are unreadable**, unshares pid+ipc+uts, `--die-with-parent`, `--new-session`; `sandbox-exec` (macOS) denies writes outside the sandbox root **and denies non-loopback network egress** (a raw-socket exfil is blocked at the OS boundary, not merely unobserved) while keeping loopback open for the capture proxy. |
| **`--require-sandbox` (fail closed)** | Refuses to run at all when no OS sandbox wrapper is available, instead of falling back to env-only isolation. For security-conscious operators who won't accept FS confinement weaker than `bwrap`/`sandbox-exec`. |

### Isolation levels

`result.isolation` reports the FS/process confinement achieved and
`result.netConfined` reports whether **non-loopback network egress is denied at
the OS boundary** (not merely unobserved by the proxy):

| Level | FS confinement | `netConfined` | How to get it |
|---|---|---|---|
| `sandbox-exec` | writes outside the sandbox root denied | **`true`** — raw-socket egress blocked | macOS (built in) |
| `bwrap+netns` | writes confined to sandbox root; real home masked by tmpfs; pid/ipc/uts isolated; **own network namespace** | **`true`** — no route out of the namespace, raw-socket egress refused (`ENETUNREACH`) | Linux with `bubblewrap` **and** `iproute2` (`ip`), when the netns self-test passes |
| `bwrap` | writes confined to sandbox root; real home masked by tmpfs; pid/ipc/uts isolated; dies with parent | `false` — net shared for the proxy | Linux with `bubblewrap` but no usable netns |
| `env-only` | **no OS FS confinement** — decoy HOME + scrubbed env + capture proxy only | `false` | fallback when none of the above are present |

At `env-only`, a payload can still write anywhere the running user can and
raw-socket egress can leave uncaptured. Use `--require-sandbox` to forbid this
fallback.

**Network-namespace confinement (`bwrap+netns`).** On Linux with both
`bubblewrap` and `iproute2`, canary runs the sandbox in its **own network
namespace** (`bwrap --unshare-net`). A fresh namespace has no route to anything
but loopback, so a payload that opens a raw socket or dials a direct IP —
bypassing the proxy env vars — is refused by the kernel (`ENETUNREACH`), not
merely unobserved. Proxy-respecting egress is still captured: the capture proxy
also listens on a Unix socket in the bind-mounted sandbox root, and a tiny
in-namespace TCP→Unix forwarder (`node <sandbox.js> __forwarder`) bridges the
payload's loopback proxy port to it. The payload therefore sees a working
`HTTP(S)_PROXY` while having no other way out.

This tier engages **only after a runtime self-test proves it in the current
environment** — the test stands up the exact same machinery with a benign probe
and requires *both* that proxied egress is captured *and* that a direct dial to
a non-loopback TEST-NET-3 IP fails with `ENETUNREACH`. If either check fails
(unprivileged user/net namespaces restricted, tooling missing), canary falls
back to shared-net `bwrap` and reports `netConfined:false` — it never *claims*
kernel confinement it hasn't demonstrated. Check your host with
`node scripts/verify-netns-confinement.js`.

## In scope — what canary is designed to catch

- **Credential exfiltration (proven):** a decoy token read from the sandbox HOME
  and transmitted over plaintext HTTP — **verbatim or base64/hex/url-encoded** —
  or appearing in an HTTPS `CONNECT` authority/URL → `behavioral-exfil` (high).
  This is *observed*, not inferred.
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
  leak. Compressed or encrypted bodies also defeat token matching (only
  reversible encodings — base64/hex/url — are decoded). *(Opt-in `--tls-mitm`
  terminates HTTPS against an ephemeral per-host CA and scans the decrypted body
  — see Hardening status below.)*
- **Raw-socket / `dgram` / non-proxied egress** is not seen by an HTTP proxy.
  On **`sandbox-exec` (macOS)** it is now **blocked** at the OS boundary
  (`netConfined: true`), so it can't leave — but it also isn't *recorded*. On
  **`bwrap`/`env-only`** the network namespace is shared, so such traffic can
  still leave uncaptured. *(Future: a loopback-only network namespace on Linux.)*
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
  `not-observed` as "not caught here," and keep the static verdict as the
  decision of record.

## Flags

```
pkgxray canary <ref> --yes-run-untrusted-code   # required opt-in
                     --require-sandbox           # fail closed without bwrap/sandbox-exec
                     --timeout <ms>              # per-run kill deadline (default 20000)
                     --keep-sandbox              # keep the throwaway root for inspection
                     --format json|markdown
```

## Hardening status

- **TLS termination** — **shipped, opt-in via `--tls-mitm`.** A per-run ephemeral
  session CA (minted with `node:crypto` alone, no `openssl`) mints a per-host leaf
  carrying the correct `subjectAltName`, injected into the child via
  `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`. A validating TLS client (Node included)
  completes the handshake and its decrypted request body is scanned, so a token
  exfiltrated inside an HTTPS body is caught (not just "phoned a host"). The
  CONNECT destination host is still recorded unconditionally, so a client that
  pins certs or ignores the CA degrades to CONNECT-host-only, never to nothing.
  **Off by default** — the default path records the destination host and never
  inspects bodies.

## Planned hardening

- **Loopback-only network namespace on Linux** (`--unshare-net` with the capture
  proxy reachable inside it), so *all* non-proxied egress is blocked by having no
  route out — extending the macOS raw-socket block (`netConfined: true`, already
  shipped via `sandbox-exec`) to `bwrap`.

Until those land, the limits above are authoritative: **absence of a finding is
not evidence of safety.**
