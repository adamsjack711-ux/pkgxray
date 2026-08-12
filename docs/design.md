# Design principles

The rules that shape every pkgxray decision, and why they hold.

## Never execute untrusted code in the default path

Traditional antivirus inspects what *executes*. pkgxray inspects what gets
*installed*. The guard flow stages a package in a private quarantine, audits the
staged bytes, and promotes it only when policy allows. It never runs
`npm install`, lifecycle scripts, build steps, or package code.

There is one deliberate exception,
[`pkgxray canary`](canary-threat-model.md). It is opt-in behind an explicit flag
(`--yes-run-untrusted-code`) and sandboxed with bwrap or sandbox-exec, where
`--require-sandbox` fails closed. One principle governs it, and the evidence it
produces runs only one way: **a canary run can confirm that a package is
malicious. It can never clear one.**

## Report only citable evidence

Every finding names the file it came from and the content that matched. If
pkgxray cannot cite it, it does not report it. That is what makes a `BLOCK`
verdict actionable: whoever reviews it, person or agent, sees *why*, not just a
number.

## Fixed rules, not a model

Fixed heuristics compute the verdict. No model reads the package to produce one.
That choice carries the whole prompt-injection story: text planted in a package
cannot steer a pkgxray verdict, because nothing in the verdict path reads it as
instructions. See [threat-model.md](threat-model.md#on-prompt-injection).

## Minimize false positives

A scanner that blocks `chalk` gets uninstalled. The false-positive budget is
enforced rather than aspirational: the [calibration benchmark](benchmark.md)
hard-fails CI on any false block. The calibration choices behind that are
documented in the [threat model](threat-model.md#why-few-false-positives). Docs
are not scanned as code, test fixtures downgrade, and minification is not
treated as obfuscation.

## Fail closed, loosen loudly

No config means the strictest settings. A scan that errors becomes `review`,
never `safe`. Every loosening of policy, whether an allow or a mute, has to be
explicit and pinned, and every report prints it. A published CVE can never be
muted away. See [configuration.md](configuration.md).

## No runtime dependencies

pkgxray is plain Node with no runtime dependencies, because a supply-chain
scanner should not be a supply-chain attack surface itself. Releases publish with
npm provenance (SLSA attestation), and release CI runs `pkgxray guard` on pkgxray
itself.

## Internal working notes

The [design/](design/) directory holds the internal specification and triage
documents. They record how each capability was specified, and how the
implementation was checked against that spec. They are working documents kept for
provenance, not docs for users.
