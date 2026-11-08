---
title: "npm ships 22 billion downloads a day — and 1 in 25 new packages is malware"
description: "The 2025 numbers on npm's scale, the open-source malware surge, and why the MCP server boom is the next soft target — with sources."
tags: [security, npm, supplychain, mcp]
canonical_url: ""
cover_image: ""
---

# npm ships ~22 billion downloads a day. Roughly 1 in 25 new packages is malware.

I build [pkgxray](https://www.npmjs.com/package/pkgxray), a zero-dependency
supply-chain scanner for npm packages and MCP servers. While writing its docs I
went looking for the current numbers on how big the npm firehose actually is,
how much of what flows through it is malicious, and whether the new Model
Context Protocol (MCP) ecosystem is repeating the same mistakes. The 2025
figures are worse than I expected. Here they are, with sources.

## The scale: npm is the internet's dependency layer

- npm served **~7.97 trillion downloads in 2025** — about **22 billion every
  day** — up **65% year over year**. Across the four largest registries (npm,
  PyPI, Maven Central, NuGet) the total was **9.8 trillion**, and npm alone is
  over 80% of it.
- The registry holds **5.59 million packages** and took on **11.18 million new
  releases in 2025** — over 60% of all new releases across every major registry.

Source: [Sonatype, 2026 State of the Software Supply Chain][sonatype-scale].

That growth isn't all humans typing `npm install`. A lot of it is transitive
dependencies, CI re-downloads, and — increasingly — AI coding agents pulling
packages automatically, often without a person ever reading the code.

## The problem: open-source malware went vertical in 2025

- **Over 99% of all open-source malware targets npm.** Attackers published
  roughly **455,000 malicious npm packages in 2025 alone.**
- Q4 2025 alone accounted for **394,877 malicious packages** — a **476%
  increase over the previous three quarters combined**, and **89% of the whole
  year's malware landed in that one quarter**. By then the rate was one new
  malicious package roughly **every 20 seconds**.
- Cumulatively, over **1.23 million malicious packages** have been catalogued
  since 2019, growing **75% year over year**.

Sources: [Sonatype OSS Malware Index, Q4 2025][sonatype-q4] ·
[Infosecurity Magazine][infosec] ·
[Sonatype press release (9.8T / +75%)][sonatype-pr].

### So how likely is a given package to be malicious?

Put the two numbers side by side. About **455,000 malicious npm packages** were
published in 2025 against roughly **11.2 million new npm releases** that year.

**That's roughly 1 in every 25 packages published to npm in 2025 — about 4%.**

A caveat, because honest numbers matter: that ratio counts malicious *packages*
against total *releases*, and 2025's tail is heavily inflated by spam campaigns.
The IndonesianFoods campaign alone generated **over 100,000 packages by
publishing a new one every seven seconds**. So the "1 in 25" figure is the *rate
of malicious publishing*, not your odds of `npm install`-ing malware on a
popular, well-downloaded package — those are far lower because download-weighting
and registry takedowns filter most spam before it reaches you. But it does mean
the registry's *published surface* is now measurably poisoned, and brand-new or
low-download packages deserve real suspicion.

The blast radius when a *popular* package is hit is the other half of the story:
the September 2025 `chalk` / `debug` compromise trojaned 18 packages with a
combined **2.6 billion weekly downloads** in a single incident.
([Palo Alto Networks][palo]).

## The next soft target: MCP servers

Model Context Protocol servers are how AI agents reach tools, data, and APIs —
and the ecosystem is exploding with almost none of npm's (belated) security
scaffolding:

- Anthropic counted **10,000+ active public MCP servers** by December 2025.
  Unofficial directories index anywhere from 17,000 to 56,000+ with minimal
  verification.
- **Only 8.5% of MCP servers use OAuth.** 53% rely on long-lived static API
  keys, and **15.4% ship no public source code at all.**
- Seven CVEs were filed against MCP implementations in the past year — the worst
  a **CVSS 9.6 remote-code-execution**. In January 2026, **42,000+ agent
  instances were found exposed on the public internet**, over 1,000 of them
  leaking credentials through unauthenticated MCP endpoints.
- One skills marketplace was found to contain **~20% malicious listings**
  (800+ of ~4,000).

Source: [NimbleBrain, State of MCP Security 2026][mcp].

This is the npm story playing out again in fast-forward: an open ecosystem
growing faster than its trust infrastructure.

## What you can actually do

Vulnerability scanners (`npm audit`, OSV-Scanner) answer *"does this package
have a known CVE?"* — essential, but a freshly trojaned package has no CVE yet.
The gap is **trust**, not just *known* vulnerabilities:

- What does the code actually do — read credentials, persist, phone home?
- Does the published npm artifact match the tagged GitHub source?
- Is there a prompt-injection payload aimed at the AI agent reading the docs?
- For MCP: what can this server *actually* reach once your agent connects?

That's the gap [pkgxray](https://github.com/adamsjack711-ux/pkgxray) fills. It's
zero-dependency, runs entirely on your machine, never executes package code
during normal scans, and returns a `SAFE` / `REVIEW` / `BLOCK` verdict with
cited evidence — *before*
a line of the package runs:

```bash
npx pkgxray guard npm:express@4.21.0     # vet a package before install
npx pkgxray mcp ./some-mcp-server        # vet an MCP server before connecting
```

It's meant to run *alongside* `npm audit` and OSV-Scanner, not replace them.

---

*Numbers pulled July 2026 from primary 2025/2026 reporting. If you spot a figure
that's drifted, open an issue.*

## Sources

- Sonatype — [2026 State of the Software Supply Chain][sonatype-scale] (download volumes, registry scale)
- Sonatype — [Open Source Malware Index, Q4 2025][sonatype-q4] (quarterly malware figures)
- Sonatype — [research press release: 9.8T downloads, +75% malware][sonatype-pr]
- Infosecurity Magazine — [454,000+ malicious open-source packages][infosec]
- Palo Alto Networks — [npm supply-chain attack breakdown][palo] (chalk/debug, 2.6B weekly downloads)
- NimbleBrain — [State of MCP Security 2026][mcp]
- [Official MCP Registry][mcp-registry]

[sonatype-scale]: https://www.sonatype.com/state-of-the-software-supply-chain/2026/software-infrastructure-growth
[sonatype-q4]: https://www.sonatype.com/blog/open-source-malware-index-q4-2025-automation-overwhelms-ecosystems
[sonatype-pr]: https://www.globenewswire.com/news-release/2026/01/28/3227372/0/en/Sonatype-Research-Reveals-OSS-Malware-Grows-75-as-Yearly-Open-Source-Downloads-Surpass-9-8-Trillion.html
[infosec]: https://www.infosecurity-magazine.com/news/454000-malicious-open-source/
[palo]: https://www.paloaltonetworks.com/blog/cloud-security/npm-supply-chain-attack/
[mcp]: https://nimblebrain.ai/blog/state-of-mcp-security-2026/
[mcp-registry]: https://registry.modelcontextprotocol.io/
