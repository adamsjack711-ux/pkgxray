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

Both phases run inside the **same** sandbox: a decoy HOME, a capture proxy, an OS
wrapper, resource caps, and a process-group kill on timeout. That changes the
finding from a static one, "this code *could* read `~/.aws/credentials` and POST
it somewhere," to one about behavior, "this package *did* read the decoy AWS key
on import and *did* try to send it to `<host>`."

Because it runs untrusted code, it is opt-in at every entry point
(`--yes-run-untrusted-code` or `PKGXRAY_ALLOW_EXECUTION=1`). This page states
what it guarantees, and where those guarantees stop, rather than implying either.

OS filesystem and network confinement is now required for real execution.
Missing wrappers, unavailable Linux network namespaces, or a failed wrapper
startup probe refuse the run before loading package code. This deliberately
tightens the former env-only/shared-network behavior of this executes-code
surface. `--require-sandbox` remains accepted; dropping it cannot weaken isolation.

**The import phase has a ceiling, and we state it rather than hide it.** The
staged package runs *without its dependencies installed*. If its entry point
`require()`s an uninstalled dependency on the first line, that throws before the
payload runs. Every detonation that skips the install faces the same ceiling. The
phase is best effort: it triggers side effects and observes them, and it does not
guarantee the module finished loading. Both supported backends restrict network
egress at the OS boundary, as the [isolation levels](#isolation-levels) explain.

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
| **OS sandbox isolation** | Required. Host file contents are readable only under operating-system/runtime roots, the staged package, the probe module and throwaway root. Writes are confined to the throwaway root. Linux uses a minimal bind-mounted filesystem and private pid/ipc/uts/network namespaces, drops capabilities, and dies with the parent. macOS uses a deny-default profile and allows outbound network only to the capture proxy's loopback port. Subprocesses inherit confinement. |
| **Fail closed** | The wrapper must start a harmless probe successfully before any package code runs. Linux must first prove both capture delivery and refusal of direct external connections. `--require-sandbox` remains a compatibility alias for the default requirement; no unrestricted fallback exists. |

### Isolation levels

`result.isolation` reports how far the filesystem and process were confined.
`result.netConfined` reports whether **the OS boundary denies non-loopback
network egress**, rather than the proxy merely not seeing it:

| Level | FS confinement | `netConfined` | How to get it |
|---|---|---|---|
| `sandbox-exec` | deny-default reads; writes confined to throwaway root | **`true`** — network limited to capture proxy port | macOS (built in) |
| `bwrap+netns` | minimal readable mounts; writes confined to throwaway root; private pid/ipc/uts/network namespaces | **`true`** — no external route | Linux with `bubblewrap` and `iproute2`, when the self-test passes |
| `injected-runner` | caller-controlled testing seam, no OS isolation claim | `false` | programmatic tests supplying `runner`; never exposed as a CLI downgrade |

The injected runner receives the wrapper but the caller controls whether it uses
it. Its results therefore do not claim achieved OS confinement or resource caps.

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
(unprivileged user/net namespaces restricted, tooling missing), canary refuses
package execution. Check your host with
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
  Both supported backends block external traffic at the OS boundary, but blocked
  attempts are not necessarily recorded by the capture proxy. macOS permits
  only the capture proxy's loopback port; Linux has no external route.
- **Sandbox-aware or dormant malware** avoids being observed by fingerprinting
  the run. It can read five things:
  - **the environment**: a set `HTTP(S)_PROXY`, a HOME under `/tmp`,
    decoy-shaped dotfiles, no shell or browser history, VM and CI hostnames
  - **time**: activation that is delayed or gated on a date, so it outlasts the
    scan window
  - **region or locale**: firing only in a target region, the node-ipc shape
  - **the network**: a C2 server that is offline or benign during the scan
  - **interaction**: waiting for real developer or runtime signals that the
    install phase never produces

  This is the basic reason a quiet canary run is not a clearance.
- **Sandbox escape.** `bwrap`/`sandbox-exec` reduce, but do not eliminate,
  kernel/wrapper-level escape risk. Treat the host as potentially exposed.
- **Incomplete runtime coverage.** Install and first import are exercised;
  behavior gated on later calls, missing dependencies or user interaction may
  remain dormant. Runtime read roots are trusted capabilities and must not
  contain secrets. OS file metadata remains readable on macOS.

## Operational guidance

- **Run canary on a disposable host** (an ephemeral CI runner or throwaway VM),
  **never on a developer machine holding real credentials.** Even with every
  control, you are executing untrusted code.
- **Provision a supported OS backend.** macOS needs usable `sandbox-exec`;
  Linux needs `bubblewrap`, `iproute2` and permitted network namespaces.
  Missing confinement fails the run even without `--require-sandbox`.
- **Use host egress restrictions as additional defense.** Neither backend
  eliminates kernel or sandbox escape risk.
- **Read canary as a positive-only signal.** Gate on `block`/`review`; treat
  `not-observed` as "not caught here," and keep the static verdict as the
  decision of record.

## Flags

```
pkgxray canary <ref> --yes-run-untrusted-code   # required opt-in
                     --require-sandbox           # accepted; isolation is required by default
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

- **Required OS confinement** — real execution requires deny-default filesystem
  access and a network boundary. macOS limits loopback to the capture port;
  Linux requires the proven network-namespace capture bridge.

The limits above remain authoritative: **absence of a finding is not evidence
of safety.**
