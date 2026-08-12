# GitHub repository metadata (manual maintainer settings)

GitHub's "About" description and topics are repository settings, not files, so a
pull request cannot change them. Apply them in **Settings → General** and in the
**About** gear on the repository landing page. Keep them in sync with this file.

## About description

Do **not** make a flat "never executes untrusted code" claim. The opt-in `canary`
mode deliberately executes package code in a sandbox. Use this instead:

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

These mirror `package.json#keywords` where the two overlap. The extra entries,
`ai-agents`, `prompt-injection`, and `devsecops`, follow GitHub topic
conventions.

## Review cadence

Re-check the About text and the topics whenever the pitch or the capabilities
change. Confirm the description still avoids the flat no-execution claim.
