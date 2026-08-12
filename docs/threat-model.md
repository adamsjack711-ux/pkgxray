# Threat model

What pkgxray defends against, where its limits are, and why it holds the
false-positive line where it does. For the exact severity of each signal, see the
[severity policy](reference.md#severity-policy-what-lands-in-block--review--info).
The opt-in `canary` surface is the one part of pkgxray that executes code, and it
has its own [canary threat model](canary-threat-model.md).

## In scope

- Malicious npm packages
- Compromised maintainer accounts (trojaned updates — see
  [`recheck`](reference.md#monitoring-pkgxray-recheck))
- Typosquatting & dependency confusion
- Credential theft (`.ssh`, `.aws`, `.npmrc`, `.env`, keychains, wallets)
- Cloud credential harvesting (AWS/GCP/Azure instance metadata, managed secret
  stores) from install-time code or next to an exfiltration sink
- Malicious lifecycle scripts
- Repository-level persistence (injected CI/CD workflows that run on the next
  push with the repository's secrets in scope)
- Self-deleting droppers (anti-forensic stage-1 cleanup)
- Registry worm replication (publishing from install-time code, or enumerating
  what the current credentials can publish to before publishing)
- Supply-chain tampering (npm artifact ≠ tagged source)
- Provenance spoofing
- AI prompt injection in package docs, code comments, and metadata
- Malicious or drifting MCP servers (see [mcp.md](mcp.md))

## Known blind spot

pkgxray reasons about the bytes in the tarball. A package that downloads and runs
its real payload *after* install can ship a clean tree. pkgxray flags the
*capability* when its shape is unambiguous, such as a `curl | sh` pattern or a
stage-2 loader. Pair it with runtime or install-time sandboxing when that risk
matters. The opt-in [`canary`](canary-threat-model.md) surface narrows this gap
but, by design, cannot close it: a canary run can *confirm* that a package is
malicious, and can never *clear* one.

## Sequence-level attacks (chained tool calls)

The standard critique of static analysis is fair: it catches known-bad patterns
but not sequences. An agent holding a set of individually reasonable tools can be
steered into chaining them. It reads a secret with an authorized read tool, then
passes it to an authorized network tool. No manifest, file, or single call in
that chain looks malicious on its own, so a scanner that judges artifacts one at
a time has nothing to flag.

pkgxray's runtime gate
([`mcp-proxy`](mcp.md#per-call-runtime-gate-pkgxray-mcp-proxy)) addresses part
of this at the session layer:

- every `tools/call` gets its own verdict. Denied and unknown tools never reach
  the server, and denied tools are stripped from the listing entirely.
- every tool **result** is scanned for injection payloads before the model reads
  it. That cuts off the main steering channel used to assemble such a chain.
- a manifest that changes mid-session is re-audited before another call passes.
  This covers `tools/list_changed` and drift from a pinned manifest.

Here is what it does **not** do: track dataflow across calls. The proxy judges
each call against the audited manifest, and keeps no record of what earlier calls
returned. A chain built entirely from *allowed* tools can complete without a
finding, if it is steered through a channel the injection scan does not see, or
by a compromised host prompt. That gap is real, and the package and manifest
layer cannot close it. The mitigations live in the consuming agent instead:
least-privilege tool grants, egress restrictions on the agent's environment, and
human confirmation on sensitive tools. pkgxray narrows the corridor. It does not
police the route taken through it.

## Why few false positives

pkgxray was validated against the 47 most-installed npm packages with **0 false
blocks**, and against a top-1000 validation run. See
[`validation/`](../validation/). These are the calibration choices that keep it
there:

- READMEs run only the prompt-injection check. Docs are not scanned as code.
- Findings in test, fixture, and example files downgrade to `review`.
- npm↔GitHub divergence is `review` rather than an automatic block, because
  renames and re-tags happen for legitimate reasons.
- Minification is **not** obfuscation. Only `eval` on a *computed* argument
  gates, which keeps heavily-bundled frontend packages out of the review pile.

CI gates these claims against regressions: the [calibration
benchmark](benchmark.md) fails on any false block or missed detection.

## On prompt injection

No scanner solves prompt injection, and pkgxray does not claim to. Its design
has three honest layers:

1. **Injection cannot reach the verdict.** Fixed heuristics compute the verdict.
   No model reads the package to decide it, so injected text cannot steer a
   pkgxray verdict.
2. **Detection targets the delivery, not the wording.** pkgxray matches *how* an
   injection is delivered: concealed characters such as the Unicode tag block
   ("ASCII smuggling"), base64 envelopes, and text hidden in a comment. That
   generalizes past rewording with very few false positives, and anything
   uncertain routes to `review` rather than a false `block`.
3. **The real fix lives in the consuming agent.** pkgxray quarantines and labels
   the untrusted package so the agent's capability controls can do their job. It
   reduces exposure. It does not replace least privilege.
