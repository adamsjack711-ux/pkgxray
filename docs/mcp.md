# MCP security

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

Use an exact npm version from any MCP-capable agent:

```json
{
  "mcpServers": {
    "pkgxray": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "pkgxray@1.0.5",
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
published `pkgxray@1.0.5` package also exposes `pkgxray mcp-server` — the same
stdio server, launched as a subcommand — which is the entry point the MCP
Registry entry uses.

| Tool | Inputs | Output and security consequence |
|---|---|---|
| `guard_agent_extension_install` | exact package reference; optional policy/promotion | downloads and stages a real package, queries npm/OSV/GitHub, and returns cited `SAFE`/`REVIEW`/`BLOCK`; optional promotion writes files |
| `audit_agent_extension_supply_chain` | caller-supplied source and metadata | pure static structured verdict; no local file read, network, install, or execution |
| `audit_lockfile_supply_chain` | manifest path under an approved root | reads the manifest, queries OSV, and returns one verdict per resolved package |
| `triage_lockfile_supply_chain` | manifest path plus bulk `allow` or `block` | writes a sibling `.pkgxray.lock`; `allow` suppresses selected findings in later audits |

The server honors the same `.pkgxray.json` policy file as the CLI — including
the `mcp` block (`tools`, `packageScanFirst`, `timeoutMs`); see
[configuration.md](configuration.md).

### Filesystem boundary

MCP tool arguments cannot grant themselves access to the filesystem. Four kinds
of path have to resolve under `PKGXRAY_MCP_ALLOWED_ROOTS`: local package
references, lockfiles, promotion targets, and quarantine roots the caller picks.
Separate multiple roots with the platform's path delimiter, `:` on macOS and
Linux, `;` on Windows. Symlinks that escape a root are rejected.

Leave the variable out and only the server's startup working directory is
allowed. Set an absolute project root in the host config, rather than leaning on
a working directory that points at the whole home directory. Set the variable to
an empty string to turn off every caller-selected path. Registry package scans
still use pkgxray's own OS quarantine.

The server rejects unknown tool arguments at runtime. Internal test/provider
options are not part of the MCP API. Guard staging is removed after each call;
returned staging paths are null, and an authorized promotion occurs before
cleanup. The server caps frames at 4 MiB and bounds queued/running requests to
32 tasks, 8 MiB retained input and four concurrent operations.

Live proxy pin checks retain initialized capabilities and instructions. A change
to either holds all tool calls under strict/balanced policy until reapproval.
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
```

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
```

`--sandbox` is optional and fails closed if the backend cannot start. It denies
network access, makes the working directory read-only, and replaces HOME/TMPDIR
with a private temporary directory. Required additional paths must already exist
and are granted explicitly; root and whole-HOME grants are refused. macOS uses
`sandbox-exec` and permits execution within the same inherited restrictions.
Linux uses `/usr/bin/bwrap` with private namespaces and an isolated filesystem;
subprocesses stay inside that namespace. Windows currently refuses this option.
Use a direct installed launcher: `npx` installation and servers needing network
access will fail under this restricted mode.

The macOS backend has passed real filesystem, symlink and network-denial tests.
Linux startup remained blocked by nested namespace restrictions on the local
Docker host; a mandatory native Linux CI job is included but has not yet run.
There is no automatic downgrade when sandbox startup fails. OS sandbox APIs and
runtime layouts vary, so validate confinement on each deployment platform.

Without `--sandbox`, the child retains the user's filesystem/network access.
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

Policies mirror the hookshot gate: `block` denies everywhere; `review` denies
under `--policy strict`, passes with a warning under `balanced` (default) and
`permissive`. A denied call never reaches the server — the agent gets an
`isError` result naming the reason.

Result screening includes resource-link descriptions, media annotations,
embedded-resource metadata, structured content, errors, initialization
instructions and responses to resource, prompt and completion requests. Textual
resource blobs and SVG images are base64-decoded before inspection. It shares a
512 KiB text budget and 10,000-node traversal budget across each response. Opaque
image, audio and binary bodies are not interpreted.
Strict policy withholds REVIEW results too; balanced withholds BLOCK results;
permissive only logs findings. `--no-scan-results` explicitly disables screening.

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
