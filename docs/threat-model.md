# Threat model

What pkgxray defends against, where its limits are, and why it holds the
false-positive line where it does. For the exact severity mapping of each
signal, see the [severity policy](reference.md#severity-policy-what-lands-in-block--review--info).
For the opt-in `canary` surface — the one part of pkgxray that executes code —
see its dedicated [canary threat model](canary-threat-model.md).

## In scope

- Malicious npm packages
- Compromised maintainer accounts (trojaned updates — see
  [`recheck`](reference.md#monitoring-pkgxray-recheck))
- Typosquatting & dependency confusion
- Credential theft (`.ssh`, `.aws`, `.npmrc`, `.env`, keychains, wallets)
- Malicious lifecycle scripts
- Supply-chain tampering (npm artifact ≠ tagged source)
- Provenance spoofing
- AI prompt injection in package docs, code comments, and metadata
- Malicious or drifting MCP servers (see [mcp.md](mcp.md))

## Known blind spot

pkgxray reasons about bytes in the tarball. A package that downloads and runs
its real payload *after* install can ship a clean tree. pkgxray flags the
*capability* when its shape is unambiguous (e.g. a `curl | sh` pattern, a
stage-2 loader), but pair it with runtime/install-time sandboxing when that
risk matters. The opt-in [`canary`](canary-threat-model.md) surface narrows —
but by design cannot close — this gap: a canary run can *confirm* malice, it
can never *clear* a package.

## Sequence-level attacks (chained tool calls)

The standard critique of static analysis — and it is a fair one — is that it
catches known-bad patterns but not sequences. An agent granted a set of
individually reasonable tools can be steered into chaining them: read a
secret with an authorized read tool, pass it to an authorized network tool.
No manifest, file, or single call in that chain looks malicious on its own,
so a scanner that judges artifacts one at a time has nothing to flag.

pkgxray's runtime gate
([`mcp-proxy`](mcp.md#per-call-runtime-gate-pkgxray-mcp-proxy)) addresses part
of this at the session layer:

- every `tools/call` gets a per-call verdict — denied and unknown tools never
  reach the server, and denied tools are stripped from the listing entirely;
- every tool **result** is scanned for injection payloads before the model
  reads it, cutting off the main steering channel used to assemble such a
  chain;
- a manifest that changes mid-session (`tools/list_changed`, pinned-manifest
  drift) is re-audited before another call passes.

What it does **not** do: track dataflow across calls. The proxy judges each
call against the audited manifest; it keeps no taint model of what earlier
calls returned. A chain assembled entirely from *allowed* tools, steered
through a channel the injection scan doesn't see (or by a compromised host
prompt), completes without a finding. That residual gap is real, and it is
not closable at the package/manifest layer — the mitigations live in the
consuming agent: least-privilege tool grants, egress restrictions on the
agent's environment, and human confirmation on sensitive tools. pkgxray
narrows the corridor; it does not police the route taken through it.

## Why few false positives

Validated against the 47 most-installed npm packages with **0 false blocks**
(and against a top-1000 validation run — see [`validation/`](../validation/)).
The calibration choices that make that hold:

- READMEs run only the prompt-injection check — docs are not scanned as code.
- Findings in test/fixture/example files downgrade to `review`.
- npm↔GitHub divergence is `review`, not auto-block — renames and re-tags
  happen legitimately.
- Minification is **not** obfuscation — only `eval` on a *computed* argument
  gates, keeping heavily-bundled frontend packages out of the review pile.

These claims are regression-gated: the [calibration benchmark](benchmark.md)
fails CI on any false block or missed detection.

## On prompt injection

Prompt injection isn't "solved" by a scanner, and pkgxray doesn't claim to.
Its design reflects three honest layers:

1. **Injection-proof by construction.** Verdicts are computed by deterministic
   heuristics, not by an LLM reading the package, so injected text can't steer
   a pkgxray verdict.
2. **Detection targets the delivery, not the wording.** Matching *how*
   injection is delivered — concealed characters (the Unicode tag block,
   "ASCII smuggling"), base64 envelopes, text hidden in a comment —
   generalizes past rewording with near-zero false positives; uncertainty
   routes to `review`, never a false `block`.
3. **The real fix lives in the consuming agent.** pkgxray quarantines and
   labels the untrusted package so the agent's capability controls can do
   their job. It reduces exposure; it does not replace least-privilege.
