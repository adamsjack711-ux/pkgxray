# README style notes

Conventions the README follows, and the high-star projects they were modeled on.
Keep the README professional *and* tight (~200 lines) — depth belongs in `docs/`.

## Exemplars studied

- **[astral-sh/ruff](https://github.com/astral-sh/ruff)** — centered header
  (badges → tagline → visual), a numbered table-of-contents with anchor links,
  emoji-prefixed highlight bullets, a "Getting started" that leads with the
  zero-install command, and a compact footer with attribution.
- **[aquasecurity/trivy](https://github.com/aquasecurity/trivy)** — a security
  scanner: centered logo + one-line tagline, a labeled **Targets / Scanners**
  dual-list instead of a wall of prose, worked examples with collapsible
  `<details>`, and outbound links to full docs rather than inlining everything.

## Conventions applied here

1. **Header** — `docs/banner.png` (regenerate from `docs/banner.svg` with
   `rsvg-convert -w 1840 -h 600 docs/banner.svg -o docs/banner.png`), then the
   canonical H1, a two-sentence description, a badge row (version, downloads,
   tests, benchmark, license), a quick-links row (Website · Docs · Calibration ·
   Report a bug), and the **demo gif** (`docs/demo/hero.gif`) with its
   "Real runs" caption. Keep the gif — it shows the tool working.
2. **Highlights** — five bold-label bullets, one line each, benefit-first.
3. **Table of contents** — one compact linked line under Highlights.
4. **Scans & detects** — a trivy-style labeled dual-list, not a table (the full
   matrix + comparison table live in `docs/` and on the website).
5. **Collapsible sample output** — `<details><summary>` so the quick start stays
   short.
6. **Footer** — centered attribution + MIT + website.

**No emoji.** They read as unprofessional here. Use bold labels, typographic
marks (·, →), and code formatting instead — never pictographic emoji (⚡🔒✅🟢
etc.) in the README.

## Accuracy rules the README must keep

- **Never** state an unscoped "never executes untrusted code" — scope it to the
  default static path (the opt-in `canary` executes package code). This applies
  to the banner subtitle too.
- Keep the `SAFE` disclaimer ("not a proof that a package is harmless").
- Pin example commands to the **current published** npm version; the reusable CI
  workflow trails until the new version is live (see the release notes in the
  memory / `CHANGELOG`).
- `test/docs-smoke.test.js` enforces the canonical description string, the pinned
  `guard npm:express@4.21.0` command, resolvable relative links, and that the
  onboarding fixture still produces `BLOCK`. Run `npm run test:docs` after edits.
