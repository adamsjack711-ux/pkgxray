# MCP security

The active flow below describes the unpublished breaking 2.0 candidate. The
1.3 work is a separate held PR. Candidate gates return binary decisions without
Proceed/Decline prompts; hosted and published releases have their own deployed
contracts. See [compatibility](compatibility.md) before migrating.

An AI agent pulls untrusted things in two ways — packages it installs, and
Model Context Protocol (MCP) servers it connects to. pkgxray covers both
directions:

| Surface | Direction | When it runs |
|---|---|---|
| [MCP server](#the-pkgxray-mcp-server) (`pkgxray-mcp`) | pkgxray *as* a tool for your agent | on demand |
| [`pkgxray mcp`](#vetting-mcp-servers-pkgxray-mcp) | vetting servers your agent connects *to* | connect time |
| [`pkgxray mcp-proxy`](#per-call-runtime-gate-pkgxray-mcp-proxy) | gating a live server session | every call |

<!-- MCP proxy diagram -->

## The pkgxray MCP server

The public hosted endpoint is `https://mcp.pkgxray.ca/mcp` (Streamable HTTP;
no API key). Add it as a remote MCP server in your client. It offers bounded
source-evidence analysis and npm metadata/OSV checks. It does not expose local
files, complete artifact scans, installation approval, or VM execution. Source
you submit is processed on Cloudflare; do not submit secrets. See the
[hosted service guide](../services/public-mcp/README.md) for limits and privacy.

For the full local MCP, use the configuration below. The official Registry
descriptor advertises both the hosted URL and the local npm package.

The configuration below targets release `pkgxray@2.0.0`; use it after npm
publication completes.

Use an exact npm version from any MCP-capable agent:

```json
{
  "mcpServers": {
    "pkgxray": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "pkgxray@2.0.0",
        "pkgxray-mcp"
      ],
      "env": {
        "PKGXRAY_MCP_ALLOWED_ROOTS": "/absolute/path/to/project"
      }
    }
  }
}
```

If pkgxray is already installed, `"command": "pkgxray-mcp"` also works. The
`pkgxray@2.0.0` package also exposes `pkgxray mcp-server` — the same
stdio server, launched as a subcommand — which is the entry point the MCP
Registry entry uses.

| Tool | Inputs | Output and security consequence |
|---|---|---|
| `guard_agent_extension_install` | exact package reference; optional policy | downloads and stages a real package, queries npm/OSV/GitHub, and returns `SAFE`/`UNSAFE` with reasons; read-only MCP rejects promotion |
| `audit_agent_extension_supply_chain` | caller-supplied source and metadata | pure static structured verdict; no local file read, network, install, or execution |
| `audit_lockfile_supply_chain` | manifest path under an approved root | reads the manifest, queries OSV, and returns one verdict per resolved package |
| `triage_lockfile_supply_chain` | manifest path plus bulk `allow` or `block` | writes a sibling `.pkgxray.lock`; `allow` suppresses selected findings in later audits |

The server honors the same `.pkgxray.json` policy file as the CLI — including
the `mcp` block (`tools`, `packageScanFirst`, `timeoutMs`); see
[configuration.md](configuration.md).

Eligible transient required-check failures retry once within the original
shared deadline against the same immutable evidence. Guard retries OSV for the
same pinned identity; supplied-evidence analysis retries only narrowly eligible
worker failures. Disabled/malformed checks, heuristic findings and permission
gaps do not retry. Persistent uncertainty blocks automatically. Explicitly
invoked triage still writes operator policy; it is not a per-event approval
prompt or a bypass for mandatory missing checks.

### Filesystem boundary

MCP tool arguments cannot grant themselves access to the filesystem. Caller-selected
paths have to resolve under `PKGXRAY_MCP_ALLOWED_ROOTS`: local package
references, lockfiles and quarantine roots the caller picks. MCP guard rejects
promotion targets rather than granting write authority.
Separate multiple roots with the platform's path delimiter, `:` on macOS and
Linux, `;` on Windows. Symlinks that escape a root are rejected.

Leave the variable out and only the server's startup working directory is
allowed. Set an absolute project root in the host config, rather than leaning on
a working directory that points at the whole home directory. Set the variable to
an empty string to turn off every caller-selected path. Registry package scans
still use pkgxray's own OS quarantine.

The server rejects unknown tool arguments at runtime. Internal test/provider
options are not part of the MCP API. Guard staging is removed after each call;
returned staging paths are null. Review arguments and session choices are
rejected; there is no remembered Proceed authorization. The server caps frames
at 4 MiB; static analysis and guard preparation use separate bounded queues.
See [the automatic contract](review-contract.md#high-traffic-mcp-safeguards) for
current request, input and worker limits.

Live proxy pin checks retain initialized capabilities and instructions. A change
to either holds all tool calls under every policy until the trusted pin is updated.
Unreadable/corrupt pins, an unavailable explicitly selected pin, or a lost
previously established baseline also hold calls. An intentionally unpinned
default session remains distinct from a failed pin check. Proxy queues, held
calls, outstanding requests, pagination, aggregate manifests and timing samples
are bounded; overflow closes or denies the affected session instead of granting
partial approval.

The agent controls tool arguments and supplied evidence. The operator controls
the process environment, working directory, `.pkgxray.json`, and executable
version. Do not allow untrusted prompts to edit those controls.

## Vetting MCP servers: `pkgxray mcp`

`pkgxray mcp` connects to a server over stdio or streamable HTTP, runs the
read-only handshake, and lists the tool manifest with `tools/list`. It never
calls a tool, reads a resource, or invokes a prompt.

```bash
# Vet the server package statically FIRST, then connect and audit the manifest
pkgxray mcp --package npm:some-mcp-server@1.4.2 npx some-mcp-server

# An HTTP server
pkgxray mcp https://mcp.example.com/mcp

# Approve: pin the manifest fingerprint into .pkgxray.lock
pkgxray mcp --pin --package npm:some-mcp-server@1.4.2 npx some-mcp-server

# Catch the rug-pull: diff the live manifest against the pin
pkgxray mcp --recheck npx some-mcp-server

# Confine enumeration of an already installed stdio server
pkgxray mcp --sandbox /absolute/path/to/node ./server.js
```

Connect-time stdio enumeration accepts the same `--sandbox-read PATH`,
`--sandbox-write PATH` and `--sandbox-network` capabilities as the runtime
proxy described below. Grants require `--sandbox`; missing OS confinement
refuses launch. It uses a private temporary HOME, a read-only project and
denied network access unless explicitly granted. Use a dedicated project
directory and an installed launcher. These options apply to local processes;
HTTP targets refuse them rather than ignoring requested isolation.

Tool enumeration refuses malformed responses, duplicate tool names and
unfinished pagination. A partial list cannot become an approved manifest.
A blocked package scan halts connection; `--force` is rejected and cannot bypass
that result. Uncertainty is a block with reasons, not a confirmed-malware label.

The manifest audit looks for:

- prompt injection in tool descriptions and the server's `instructions` blurb
- concealed Unicode / base64 envelopes
- **capability-surface mismatch**, an MCP-specific check for a tool whose schema
  reaches past its stated purpose, such as a `get_weather` that also takes a
  `command`

> **The one caveat.** Everything else pkgxray does is static, but listing a stdio
> server's tools means spawning and running it. `pkgxray mcp` narrows that risk:
> it scrubs the environment down to an allowlist, sets a hard timeout, bounds the
> output, and kills the process group once listing finishes. The safe order is
> still **package scan first**. Pass `--package <ref>` so the scan that runs
> nothing clears the server before anything connects. `--no-package-scan` skips
> that step, and you have to ask for it.

## Per-call runtime gate: `pkgxray mcp-proxy`

`pkgxray mcp` is connect-time. Two attacks only exist *inside* a live session:
a manifest that changes after approval (the rug-pull moving in real time) and
poisoned tool **output** steering the model. `mcp-proxy` sits on the wire —
point the host's server config at the proxy and it launches the real server as
its child, relaying every JSON-RPC frame through the gate.

```jsonc
// .mcp.json — wrap the real launcher
{
  "mcpServers": {
    "some-server": {
      "command": "pkgxray",
      "args": ["mcp-proxy", "--", "npx", "some-mcp-server"]
    }
  }
}
```

The child receives a minimal environment by default. Pass each required
credential explicitly: `pkgxray mcp-proxy --env GITHUB_TOKEN --env API_KEY -- node server.js`.
Values come from the proxy's environment, so secrets do not appear in the command
line. Missing names and runtime injection overrides such as `NODE_OPTIONS`,
`LD_PRELOAD`, and `PATH` are rejected. Bare commands use the same controlled
resolution as the connect-time client; use an absolute launcher path when needed.
This changes the previous full-environment inheritance behavior.

To require OS confinement, use a dedicated project directory and launch an
installed server directly:

```sh
pkgxray mcp-proxy --sandbox -- /absolute/path/to/node ./server.js
pkgxray mcp-proxy --sandbox --sandbox-read /path/to/input --sandbox-write /path/to/output -- /absolute/path/to/node ./server.js
pkgxray mcp-proxy --sandbox --sandbox-network -- /absolute/path/to/node ./network-server.js
```

`--sandbox` is optional and fails closed if the backend cannot start. It denies
network access, makes the working directory read-only, and replaces HOME/TMPDIR
with a private temporary directory. Required additional paths must already exist
and are granted explicitly; root and whole-HOME grants are refused. macOS uses
`sandbox-exec` and permits execution within the same inherited restrictions.
Linux uses `/usr/bin/bwrap` with private namespaces and an isolated filesystem;
subprocesses stay inside that namespace. Windows currently refuses this option.
Use a direct installed launcher. Network-dependent servers can explicitly add
`--sandbox-network`, which grants the host network while preserving filesystem
confinement. This is unrestricted network access, not a hostname allowlist;
enforce narrower egress policy outside pkgxray when needed. Network and path
grants require `--sandbox`. Dependency downloads still need explicit filesystem
grants and may be incompatible with the read-only project directory.

The macOS backend has passed real filesystem, symlink and network-denial tests.
Linux startup remained blocked by nested namespace restrictions on the local
Docker host; a mandatory native Linux CI job is included but has not yet run.
There is no automatic downgrade when sandbox startup fails. OS sandbox APIs and
runtime layouts vary, so validate confinement on each deployment platform.

Without `--sandbox`, the child retains the user's filesystem/network access.

### Credential reuse across calls (opt-in)

```bash
pkgxray mcp-proxy --guard-secrets --sandbox --policy strict -- /absolute/path/to/node ./server.js
```

Run from a dedicated project directory. `--guard-secrets` remembers non-empty
string values in explicitly credential-labelled fields in correlated responses:
`password`, `passwd`, `apiKey`, `accessToken`, `refreshToken`, `clientSecret`,
`privateKey`, and `authorization` (case, hyphens and underscores are ignored).
Nested structured results and valid JSON text are inspected. Bearer/Basic header
payloads are also retained. A later outbound frame containing a remembered value,
one URL-encoding layer (including mixed-case escapes), or its standard
Base64/Base64url representation is denied
before forwarding. Held tool calls are rechecked after manifest verification.
The guard applies alongside mandatory injection-result screening under every
runtime policy; it never grants an approval. A rejected request gets a
JSON-RPC error. An uninspectable raw frame, or a credential-bearing notification
or response without a request to reject, closes the session.

Values are kept only in the proxy's private memory, never in reports, logs, or a
disk cache. Each proxy has independent state, discarded on exit. Inspection is
bounded to 128 KiB of strings/keys, 10,000 values and 32 nesting levels per frame,
with at most 128 credentials of 4 KiB each retained. Exceeding a limit withholds
the response and holds later traffic until restart instead of forgetting old
evidence. A malicious server can cause this denial of service; the guard does
not silently resume with less protection.

This is exact-value correlation within one proxied server session, not general
cross-server data-flow tracking. It does not identify arbitrary personal data,
unlabelled credentials in prose, binary attachments, split values, arbitrary
encodings, or data sent before the response was observed. Even a short labelled
password can match ordinary later text and cause a false positive. Review the
workflow separately rather than treating the error as a package verdict. The
server already possesses its own responses: direct server-side exfiltration is
outside this check and requires OS network restrictions. `--sandbox` constrains
the wrapped server and its descendants, not the coding agent or other servers.
Even with it, explicitly readable directories may contain credentials and
explicitly passed secrets remain available to the server. System/runtime read
roots and granted paths are trusted capabilities, not a guarantee against kernel
exploits, CPU exhaustion, or malicious content returned through MCP stdout.

| Moment | Check | Cost |
|---|---|---|
| first `tools/list` | full static manifest audit; denied tools are **stripped from the listing** | ~1 ms per 30 tools |
| every `tools/call` | in-memory verdict lookup; unknown / blocked tools denied | **~0.05 µs** |
| `tools/list_changed` | immediate re-list + re-audit; mid-verification calls **held**, then decided against the fresh manifest | one manifest audit |
| every response to a client request | doc-typed injection scan of model-visible text, capped at 512 KiB | ~0.06 ms for 2 KB |
| after `--pin` | fresh manifest diffed against pinned fingerprints; **drifted tools denied** until re-approved | one lock-file read |

`strict`, `balanced` (default) and `permissive` all deny blocking findings,
manifest uncertainty, failed pin verification and pin drift. A denied call never reaches the server — the agent gets an
`isError` result naming the reason. The denial is call-scoped, not
session-scoped: its structured content reports `session: active` and
`continuationAllowed: true`, so hosts and agents can continue the workflow with
approved tools instead of treating one blocked capability as a dead connection.

Result screening includes resource-link descriptions, media annotations,
embedded-resource metadata, structured content, errors, initialization
instructions and responses to resource, prompt and completion requests. Textual
resource blobs and SVG images are base64-decoded before inspection. It shares a
512 KiB text budget and 10,000-node traversal budget across each response. Opaque
image, audio and binary bodies are not interpreted.
Every policy withholds uncertain or blocked results. `--no-scan-results` is
removed and rejected; result screening cannot be disabled.

Manifest pinning verifies descriptions and schemas, not executable behavior.
Changes without a notification are not automatically re-enumerated, and identical
manifests can conceal changed behavior even with repeated enumeration. Use a
reviewed, hash-pinned installed artifact and `--sandbox` to constrain execution.
Calls are authorized by tool name; arguments, cross-call dataflow, server
notifications and opaque media still require controls in the consuming host.

> **HTTP servers aren't wrapped** — the proxy launches stdio children only.
> Vet HTTP servers with connect-time `pkgxray mcp <url>` plus
> `--pin` / `--recheck`.

## Further reading

- [Performance](reference.md#performance) — measured proxy gate overhead
- [compatibility.md](compatibility.md) — which MCP surfaces are Stable vs. Experimental
- [design/mcp-adapter-prompt.md](design/mcp-adapter-prompt.md) — the connect-time trust-layer specification
- [design/mcp-adapter-triage.md](design/mcp-adapter-triage.md) — implementation verified against that spec

## Experimental Compose analysis

Set `PKGXRAY_COMPOSE=1` in the local MCP operator environment to expose
`analyze_package_composition`; restrict input using `PKGXRAY_MCP_ALLOWED_ROOTS`.
Its `.pkgxray.json` tool key is `compose`. See [Compose setup and limits](compose.md).
