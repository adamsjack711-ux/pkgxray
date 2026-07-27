# Launch review and handoff

This file prioritizes the package; it does not authorize publication or
outreach.

## Five highest-impact assets

1. **Show HN submission plus first comment** — the strongest venue for a
   reproducible open-source security tool, provided the maintainer is available
   to answer technical challenges.
2. **Thirty-second package-gate demo** — the fastest proof of the core promise:
   one real package, one clearly labelled reconstructed fixture, cited evidence,
   and stable exit codes.
3. **DEV technical article** — the durable explanation of pre-install analysis,
   MCP risk, calibration scope, and limitations; use it as the canonical
   long-form launch reference.
4. **Public methodology and benchmark reproduction path** — link the retuned
   run, committed inputs, benchmark harness, and exact command. This is the
   credibility layer behind every short-form claim.
5. **“What pkgxray does differently from npm audit and OSV-Scanner” explainer**
   — useful for the README, website, launch replies, and search; it positions
   pkgxray as a complementary layer instead of an exaggerated replacement.

## Recommended launch order

1. **Approval and coherence pass**
   - Fill the maintainer biography/contact placeholders.
   - Approve exact wording, screenshots, logo use, and channel ownership.
   - Re-run the tests, benchmark, and every recorded demo.
   - Confirm `pkgxray.ca` canonical URLs and the retuned calibration page.
2. **Evidence foundation**
   - Ensure the website methodology, retuned aggregate, repository inputs,
     README, and npm page state the same denominator and limitations.
   - Record the 30-second and 60-second demos from clean sessions.
3. **Primary launch**
   - Publish Show HN first, with the maintainer present for replies.
   - Add the prepared first comment immediately after submission.
4. **Technical depth**
   - Publish the DEV article after the initial discussion reveals which
     questions need the most emphasis.
   - Post the GitHub Discussions announcement as the project-owned reference.
5. **Community adaptations**
   - Share the Node.js Reddit version, then the cybersecurity and MCP versions
     on separate days. Follow each community's self-promotion rules.
   - Use LinkedIn, X, and Mastodon as pointers to evidence, not identical
     cross-posts.
6. **Sustained education**
   - Begin the 12-week calendar and recurring series.
   - Pitch newsletters and podcasts only after maintainer approval and only
     through normal, non-automated outreach.
7. **Optional**
   - Consider Product Hunt only after technical communities have supplied
     feedback and the onboarding path has been refined.

## Items requiring maintainer approval

- Maintainer biography, pronouns, title/affiliation, contact details, and any
  future personal quotation.
- Final Show HN, Reddit, DEV, social, newsletter, podcast, and Product Hunt copy.
- Which accounts may represent the project and who will answer replies.
- Logo selection, screenshot selection, alt text, credits, and trademark usage.
- Whether named benign packages may appear in demos or calibration stories.
- Whether to mention the `registry-url` calibration incident by name.
- Exact release framing: v1.0.3 is documentation-only and should not be
  presented as a new detection-engine release.
- The publishing cadence, community-rule checks, disclosure review, and
  embargo handling.
- Any use of the Experimental browser extension or Hookshot integration as a
  launch headline.
- The public domain strategy: promotional copy and the repository website
  metadata both use `https://pkgxray.ca` canonicals (verified by
  `website/validate.mjs`).

## Claims needing external verification immediately before publication

| Claim | Verification needed |
|---|---|
| npm malware volume and publication cadence | Re-open the cited Sonatype 2026 report/OSS Malware Index; verify the exact figure, period, denominator, and wording. |
| MCP ecosystem posture statistics | Re-open the cited Anthropic update and registry audits; use only directly supported figures with dates and links. |
| Current `npm audit` capabilities | Check current npm CLI documentation, especially `npm audit signatures`, remediation behavior, and provenance wording. |
| Current OSV-Scanner scope | Check current OSV-Scanner documentation for ecosystems, lockfile support, and capabilities before publishing the comparison table. |
| Weekly package download counts | Refresh npm download API values or omit them; they are time-sensitive and unnecessary to the core pitch. |
| Performance figures | Re-run the documented benchmark on the stated Apple M1/Node 26 setup, or label existing numbers with that environment and date. |
| Hookshot agent compatibility | Verify the current external Hookshot ABI and each named agent integration before claiming support. |
| Website routing and canonical host | Confirm `pkgxray.ca` serves `/stats`, `/stats/methodology`, and immutable run routes; align canonical tags before SEO publication. |
| npm release state | Re-check npm `latest`, package provenance display, registry signature, license, and Node engine immediately before launch. |

Repository-backed facts should still be pinned to a release or commit when
quoted outside the project.

## Content that should not be published yet

- **Maintainer bio or press contact fields** until supplied and approved.
- **Any universal “zero false positives/blocks” statement.** Only the scoped
  top-1000 heuristic result is supported.
- **Any claim that pkgxray proves safety, catches all malware, or solves prompt
  injection.**
- **Any claim that provenance is fully cryptographically verified.**
- **Any description of reconstructed fixtures as live malware or live-registry
  recall.**
- **Per-package verdict lists or a public package-to-verdict lookup.** The
  repository's policy treats this as an attacker-tuning oracle.
- **Uncoordinated claims about newly discovered malicious packages or MCP
  servers.** Follow the project's private disclosure policy first.
- **Experimental integrations framed as Stable or production guarantees.**
- **Canary as a clearance mechanism or as safe to run on a credential-bearing
  developer machine.**
- **Unverified third-party threat statistics, performance figures, download
  counts, compatibility claims, testimonials, adoption numbers, stars, or
  integrations.**
- **SEO pages** until domain canonicals, route ownership, and anti-cannibalization
  choices are approved.

## Final preflight

- [ ] Tests and benchmark pass on the release commit.
- [ ] Demo commands are re-run; only live captured output is shown.
- [ ] Every reconstructed fixture is labelled on screen and in narration.
- [ ] Runtime later-stage payload limitation appears in long-form assets.
- [ ] Calibration sentence includes “heuristic,” “after calibration,” date,
      top-1000, and “most-downloaded.”
- [ ] MCP over-blocking boundary appears wherever MCP and calibration are
      discussed together.
- [ ] `SAFE` is defined as an evidence result, not proof.
- [ ] All external facts have current citations.
- [ ] Maintainer and disclosure approvals are recorded.
