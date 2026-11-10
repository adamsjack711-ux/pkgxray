# Roadmap

The goal is one explainable review: **what each package does, how packages connect,
and what evidence supports the decision.** Milestones have acceptance criteria,
not promised dates.

## Available · v0.4

- Bounded CommonJS/ESM cross-package tracing with locked instance resolution,
  static imports, named re-exports, and selected package export conditions.
- Source/call/return/network evidence, including chained primitive formatting.
- Local pkgxray evidence adapter, combined terminal/JSON reports, preserved
  blocking findings, and explicit coverage gaps.
- Sensitive/public/unsupported/blocked controls and compatibility testing against
  a pinned public pkgxray commit.

## Next · broader useful coverage

Add specified string operations, async/callback/array handling, and wider ESM
coverage. Each addition needs a real-package example, a sensitive/harmless
pair, and tests showing unknown semantics remain incomplete. Broad `ms`,
`wordwrap`, and `qs` scenarios are not a solved compatibility benchmark.

Acceptance: more real paths finish without inventing dataflow, losing traces,
executing target code, or hiding gaps. Publish unsupported cases alongside wins.

## Verified pkgxray handoff

Define a snapshot pkgxray can supply from held, verified archives. Bind package
instances, registry integrity, file bytes, entrypoints, scanner versions, and
requested/completed checks. Expand collection beyond selected flow files.

Acceptance: changed bytes, mismatched identities, missing files, stale contracts,
and partial required checks cannot receive installation approval. Local hash
agreement must never become a registry-authentication claim.

## Policy integration

Feed composition evidence into pkgxray's policy and artifact-approval workflow.
Make intended credential destinations reviewable. Retain blocks and mandatory
uncertainty instead of averaging engines into a score.

Acceptance: end-to-end tests show that no clean composition result clears a
blocked package, and no permitted destination conceals unrelated findings.

## Readiness evidence

Build a reproducible real-package corpus with independently reviewed expected
results. Measure missed routes, false findings, incomplete coverage, runtime,
and memory separately. Complete hostile-input review before claiming production
readiness. Passing our own regression suite is not that review.
