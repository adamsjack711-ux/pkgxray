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

MCP tool arguments cannot grant themselves filesystem access. Local package
references, lockfiles, promotion targets, and caller-selected quarantine roots
must resolve under `PKGXRAY_MCP_ALLOWED_ROOTS`. Multiple roots use the platform
path delimiter (`:` on macOS/Linux, `;` on Windows). Symlink escapes are
rejected.

When the variable is omitted, only the server's startup working directory is
allowed. Set an absolute project root in host configuration rather than relying
on an application-wide home-directory working directory. Set the variable to an
empty string to disable all caller-selected filesystem paths; registry package
scans still use pkgxray's internal OS quarantine.

The agent controls tool arguments and supplied evidence. The operator controls
the process environment, working directory, `.pkgxray.json`, and executable
version. Do not allow untrusted prompts to edit those controls.

## Vetting MCP servers: `pkgxray mcp`

`pkgxray mcp` connects to a server (stdio or streamable HTTP), performs the
read-only handshake, and enumerates the tool manifest via `tools/list` —
never calling a tool, reading a resource, or invoking a prompt.

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
- **capability-surface mismatch** — an MCP-specific check for a tool whose
  schema exceeds its stated purpose (a `get_weather` that also takes a
  `command`)

> **The one caveat:** everything else pkgxray does is static, but enumerating
> a stdio server means spawning and running it. `pkgxray mcp` narrows the risk
> (an allowlist-scrubbed environment, a hard timeout, bounded output, its
> process group killed after listing), but the safe order is
> **package-scan first** — pass `--package <ref>` so the no-execution scan
> clears the server before anything connects. `--no-package-scan` skips it
> explicitly.

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

| Moment | Check | Cost |
|---|---|---|
| first `tools/list` | full static manifest audit; denied tools are **stripped from the listing** | ~1 ms per 30 tools |
| every `tools/call` | in-memory verdict lookup; unknown / blocked tools denied | **~0.05 µs** |
| `tools/list_changed` | immediate re-list + re-audit; mid-verification calls **held**, then decided against the fresh manifest | one manifest audit |
| every `tools/call` result | doc-typed injection scan of the result text, capped at 512 KiB | ~0.06 ms for 2 KB |
| after `--pin` | fresh manifest diffed against pinned fingerprints; **drifted tools denied** until re-approved | one lock-file read |

Policies mirror the hookshot gate: `block` denies everywhere; `review` denies
under `--policy strict`, passes with a warning under `balanced` (default) and
`permissive`. A denied call never reaches the server — the agent gets an
`isError` result naming the reason.

> **HTTP servers aren't wrapped** — the proxy launches stdio children only.
> Vet HTTP servers with connect-time `pkgxray mcp <url>` plus
> `--pin` / `--recheck`.

## Further reading

- [Performance](reference.md#performance) — measured proxy gate overhead
- [compatibility.md](compatibility.md) — which MCP surfaces are Stable vs. Experimental
- [design/mcp-adapter-prompt.md](design/mcp-adapter-prompt.md) — the connect-time trust-layer specification
- [design/mcp-adapter-triage.md](design/mcp-adapter-triage.md) — implementation verified against that spec
