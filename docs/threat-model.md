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
