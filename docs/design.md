# Design principles

The rules that shape every pkgxray decision, and why they hold.

## Never execute untrusted code in the default path

Traditional antivirus inspects what *executes*; pkgxray inspects what gets
*installed*. The guard flow stages a package in a private quarantine, audits
the staged bytes, and only promotes when policy allows — it never runs
`npm install`, lifecycle scripts, build steps, or package code.

The sole, deliberate exception is [`pkgxray canary`](canary-threat-model.md):
opt-in behind an explicit flag (`--yes-run-untrusted-code`), sandboxed
(bwrap / sandbox-exec, with `--require-sandbox` failing closed), and governed
by an asymmetric-evidence principle — **a canary run can confirm malice; it
can never clear a package.**

## Report only citable evidence

Every finding names the file it came from and the content that matched. If
pkgxray can't cite it, it doesn't report it. This is what makes a `BLOCK`
verdict actionable: the human (or agent) reviewing it sees *why*, not just a
number.

## Deterministic, not model-driven

Verdicts are computed by deterministic heuristics, not by an LLM reading the
package. That choice is load-bearing for the prompt-injection story: injected
text in a package cannot steer a pkgxray verdict, because no model reads the
package to produce one. See [threat-model.md](threat-model.md#on-prompt-injection).

## Minimize false positives

A scanner that blocks `chalk` gets uninstalled. The false-positive budget is
enforced, not aspirational: the [calibration benchmark](benchmark.md) hard-fails
CI on any false block, and the calibration choices (docs aren't code,
test fixtures downgrade, minification isn't obfuscation) are documented in the
[threat model](threat-model.md#why-few-false-positives).

## Fail closed, loosen loudly

Zero config is maximum strictness. A scan that errors becomes `review`, never
`safe`. Policy loosenings (allows, mutes) must be explicit, pinned, and are
printed in every report — and a published CVE can never be muted away. See
[configuration.md](configuration.md).

## Zero runtime dependencies

pkgxray is plain Node with no runtime dependencies — a supply-chain scanner
should not itself be a supply-chain attack surface. Releases are published
with npm provenance (SLSA attestation), and release CI runs
`pkgxray guard` on pkgxray itself.

## Internal working notes

The [design/](design/) directory holds the internal specification and triage
documents — how each capability was specified and how the implementation was
checked against that spec. They are working documents kept for provenance,
not user-facing docs.
