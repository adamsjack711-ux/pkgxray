# pkgxray promotion package

Publication-ready source material for a technically credible pkgxray launch.
Nothing in this directory authorizes posting, outreach, account creation,
advertising, or submission. Every public asset requires maintainer review.

Primary positioning: **Inspect what gets installed before it executes.**

## Contents

1. [`01-positioning.md`](01-positioning.md) — core descriptions, audience
   pitches, comparison with `npm audit` and OSV-Scanner, and claim boundaries.
2. [`02-launch-materials.md`](02-launch-materials.md) — community-specific
   launch copy for Show HN, Reddit, DEV, social, GitHub, MCP communities,
   newsletters, podcasts, and optional Product Hunt.
3. [`03-demonstrations.md`](03-demonstrations.md) — ten reproducible recording
   scripts with commands, expected key output, narration, exclusions, and
   disclaimers.
4. [`04-content-calendar.md`](04-content-calendar.md) — 12 weeks of one
   substantial and two smaller technical posts per week.
5. [`05-recurring-series.md`](05-recurring-series.md) — six reusable,
   evidence-first editorial formats.
6. [`06-seo-briefs.md`](06-seo-briefs.md) — nine differentiated search briefs,
   route strategy, citation policy, and anti-cannibalization map.
7. [`07-press-newsletter-kit.md`](07-press-newsletter-kit.md) — facts, FAQ,
   maturity table, limitations, announcements, asset requirements, and
   maintainer placeholders.
8. [`08-launch-review.md`](08-launch-review.md) — highest-impact assets,
   recommended sequence, approval checklist, external-verification queue, and
   hold-back list.

## Non-negotiable claim boundaries

- `SAFE` means no high- or medium-risk indicator was found in the inspected
  evidence. It does not prove that a package is harmless.
- The measured claim is **0 heuristic false blocks after calibration on the
  2026-07-19 top-1000 most-downloaded npm package set**. It is not a
  registry-wide or MCP-ecosystem claim.
- A separate 300-package MCP hunting set exposed known over-blocking and is
  outside that denominator.
- Malware benchmark cases are reconstructed, advisory-modeled fixtures, not
  live malware. The current committed benchmark reports 19/20 blocking, the
  remaining case at `REVIEW`, and none passing `SAFE`.
- Static inspection can miss a clean package that downloads a later-stage
  payload at runtime. Runtime isolation and least privilege remain
  complementary controls.
- Provenance is parsed, digest-bound, and cross-checked; pkgxray does not perform
  complete Sigstore/Fulcio/Rekor cryptographic verification.
- `guard`, lockfile audit, `recheck`, JSON/exit codes, `pkgxray-mcp`, `mcp`, and
  stdio `mcp-proxy` are Stable. The browser extension and Hookshot integration
  are Experimental. `canary` is supported and opt-in, executes untrusted code,
  and can confirm observed malice but never clear a package.

## Verified while preparing this package

- Repository `main` matched `origin/main`.
- Published npm metadata reported `pkgxray@1.0.3`, MIT, Node `>=18`.
- Test suite: 520 passed, 0 failed, 1 skipped.
- Committed benchmark: 50 cases; 100% block precision, 95% block recall,
  0 false blocks, 0 full misses; all hard gates passed.

Network-backed package, OSV, GitHub, and download-count facts are
point-in-time. Re-run demonstrations and re-check cited external sources before
publication.
