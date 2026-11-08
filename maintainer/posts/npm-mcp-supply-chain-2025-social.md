# Social versions — npm/MCP supply-chain stats

Short copies of the long post for fast channels. Swap in your own links.

---

## X / Bluesky / Mastodon thread

**1/**
npm served ~7.97 TRILLION downloads in 2025 — about 22 billion a day, up 65% YoY.

It's the internet's dependency layer. It's also the most attacked one. 🧵

**2/**
Over 99% of all open-source malware targets npm.

~455,000 malicious npm packages were published in 2025 alone. By Q4 the rate hit one new malicious package every ~20 seconds.

**3/**
Do the math against ~11.2M new npm releases in 2025:

roughly 1 in 25 packages published to npm last year was malware (~4%).

(Caveat: spam campaigns inflate the tail — one bot published a new malicious package every 7 seconds. Popular packages are safer; brand-new ones are the risk.)

**4/**
When a *popular* package gets hit, the blast radius is enormous.

Sept 2025: the chalk/debug compromise trojaned 18 packages with 2.6 BILLION combined weekly downloads. One incident.

**5/**
Now the MCP server ecosystem is doing it all again in fast-forward.

10,000+ public servers. Only 8.5% use OAuth. 15% ship no source. One marketplace: ~20% of listings malicious. 42,000+ agent instances found exposed online.

**6/**
Vuln scanners answer "known CVE?" — but a freshly trojaned package has no CVE yet. The gap is trust.

I built pkgxray to close it: it scans what you *install* and gates what your agent *connects to*, before a line runs. Zero deps, local, MIT.

npx pkgxray guard npm:express@4.21.0
→ github.com/adamsjack711-ux/pkgxray

Sources: Sonatype 2026 State of the Software Supply Chain + Q4 2025 OSS Malware Index; NimbleBrain State of MCP Security 2026; Palo Alto Networks.

---

## LinkedIn (single post)

npm served ~7.97 trillion downloads in 2025 — roughly 22 billion a day, up 65% year over year. It's the backbone of modern software. It's also where over 99% of all open-source malware now lands.

The 2025 numbers, from Sonatype's supply-chain research:

• ~455,000 malicious npm packages published in a single year
• Q4 2025 alone: 394,877 — an 89% share of the whole year's malware
• That's roughly 1 in 25 packages published to npm being malicious

A caveat worth stating: that ratio is inflated by spam campaigns (one bot published a new malicious package every 7 seconds), so it's the rate of malicious *publishing*, not your odds on a popular package. But the registry's published surface is measurably poisoned — and AI coding agents increasingly install packages with no human reading the code.

The next soft target is already here: the Model Context Protocol ecosystem has 10,000+ public servers, only 8.5% use OAuth, and one marketplace was found ~20% malicious. Same story, faster.

Traditional vulnerability scanners answer "does this have a known CVE?" — but a freshly trojaned package has no CVE yet. The gap is trust, not just known vulnerabilities.

That's why I built pkgxray — a zero-dependency, local-only scanner that vets npm packages and MCP servers *before* they run and returns a SAFE / REVIEW / BLOCK verdict with cited evidence. It runs alongside npm audit and OSV-Scanner, not instead of them.

→ github.com/adamsjack711-ux/pkgxray

Sources in comments. #softwaresupplychain #npm #appsec #aisecurity

---

## Hacker News (Show HN)

**Title:** Show HN: pkgxray – vet npm packages and MCP servers before they run

**Text:**
npm shipped ~7.97T downloads in 2025 and ~455k malicious packages were published to it that year (99%+ of all open-source malware targets npm). Vuln scanners catch known CVEs, but a freshly trojaned package doesn't have one yet.

pkgxray is a zero-dependency, local-only tool that analyzes what a package actually *does* — credential reads, persistence, network exfil, npm-vs-GitHub source mismatch, prompt-injection payloads aimed at AI agents — and returns SAFE / REVIEW / BLOCK with cited evidence before anything executes. It also vets MCP servers, an ecosystem that's now 10,000+ servers with only 8.5% using OAuth.

No LLM in the verdict path (so injected text can't steer it), zero-false-block calibration regression-gated in CI. Runs alongside npm audit / OSV-Scanner. MIT.

[link] — feedback welcome, especially on false positives.
