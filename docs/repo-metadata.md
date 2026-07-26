# GitHub repository metadata (manual maintainer settings)

GitHub's "About" description and topics are repository settings, not files, so
they cannot be changed from a pull request. Apply these in **Settings → General**
and the **About** gear on the repository landing page. Keep them in sync with
this file.

## About description

Do **not** use an absolute "never executes untrusted code" claim — the opt-in
`canary` mode deliberately executes package code in a sandbox. Recommended:

> Pre-install security for AI agents, npm packages, and MCP servers. Zero-dep
> local static analysis; normal scans never execute package code.

- Website: `https://pkgxray.ca`
- "Include in the home page" links: leave the repository homepage set to
  `https://pkgxray.ca/`.

## Topics

Descriptive, not keyword-stuffed:

```
ai-agents
ai-agent-security
mcp
mcp-security
model-context-protocol
npm
npm-security
prompt-injection
static-analysis
supply-chain-security
devsecops
```

These mirror `package.json#keywords` where they overlap; the extra entries
(`ai-agents`, `prompt-injection`, `devsecops`) are GitHub-topic conventions.

## Review cadence

Re-check the About text and topics whenever the pitch or capabilities change,
and confirm the description still avoids the absolute no-execution claim.
