# Design notes

Internal design and triage notes kept for provenance. These are **working
documents**, not user-facing docs — they record how a capability was specified
and how the implementation was checked against that spec. For usage, see the
[top-level README](../../README.md) and the [reference](../reference.md).

| Doc | What it covers |
|---|---|
| [mcp-adapter-prompt.md](mcp-adapter-prompt.md) | The connect-time MCP trust-layer specification (the `pkgxray mcp` adapter). |
| [mcp-adapter-triage.md](mcp-adapter-triage.md) | Verifies the MCP adapter implementation against that spec, task by task. |
| [recheck-triage.md](recheck-triage.md) | Triage of the `pkgxray recheck` monitoring tier (verdict-drift + version-drift). |
| [integration-triage.md](integration-triage.md) | hookshot install-gate hardening triage. |
| [evasion-triage.md](evasion-triage.md) | Behavioral HIGH rules vs. string-splitting / hidden-sink evasion. |
