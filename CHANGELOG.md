# Changelog

## 0.3.1

- Retain unsupported ESM source bytes for pkgxray evidence and fingerprinting;
  flow coverage remains explicitly incomplete.
- Add a read-only Tapp entry-file baseline and regressions for evidence retention,
  source changes, byte bounds, symlinks, and nonexecution. Private application
  source and generated reports stay outside the repository.

## 0.3.0

- Center the project on package inspection plus cross-package connection tracing.
- Add a real pkgxray `auditEvidence` adapter with selected file-hash checks and
  bounded worker execution.
- Add combined terminal/JSON reports, partial coverage, preserved blocks and gaps,
  and no installation-approval result.
- Add a four-case demo, failure tests, pinned upstream compatibility CI, and
  architecture, contract, roadmap, and contribution documentation.

## 0.2.1

- Preserve provenance through repeated concatenation, templates, conversions,
  JSON serialization, and package returns.
- Separate primitive types from unknown contents and arbitrary behavior.
- Keep custom serialization/cycles/coercion explicit; deduplicate traces without
  hiding budget exhaustion. Add the string-flow demo.

## 0.2.0

- Extend CommonJS scope, assignments, primitive operations, and bounded branch
  exploration. Unknown feasibility remains incomplete.
- Add pinned `ms@2.1.3` numeric-path and unknown-input controls.

## 0.1.0

- Introduce offline lockfile resolution, bounded CommonJS interpretation,
  cross-package evidence, JSON/CLI output, and the pkgxray boundary probe.
- Bundle Acorn with license and provenance metadata.
