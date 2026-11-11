# pkg x-ray website

Canonical static HTML/CSS/JS source for <https://pkgxray.ca/>. No build step,
external fonts, or runtime package dependencies are needed for the homepage.
The separate `pkgxray-site` repository is a deployment mirror; do not edit it
independently. This revision is local-only and has not been published.

## Local preview and checks

From the repository root:

```sh
python3 -m http.server 8799 --bind 127.0.0.1 --directory website
npm run validate:website
node --test website/check-home.mjs
node --check website/app.js
```

Open <http://127.0.0.1:8799/> in **Dia**. The Python preview does not apply
Cloudflare's `_headers`; the existing CSP and security headers are preserved
and checked by the validator. Leave HeyClicky's separate port 8766 server alone.

## Design references and implementation

Mobbin MCP `search_sections` returned and displayed actual library images on
2026-11-08. Accessible search covers website sections and web/iOS screens and
flows; no separate directory enumeration tool is exposed. Broad section searches
included developer tools and security products before these references were selected.

| Inspected reference | Adapted principle | Local implementation |
| --- | --- | --- |
| [Linear hero](https://mobbin.com/sites/sections/40a46191-a57a-4bab-9a92-94fc14cad817) | Restrained navigation, centered hierarchy, limited line lengths, generous space between introduction and product evidence | The ASCII identity leads; centered purpose and actions follow; a single 1040px content grid governs the page. No copied gradients, brand assets, or interface imagery. |
| [Greptile code evidence](https://mobbin.com/sites/sections/1b9bae9d-3e5e-4c60-8be0-e115e4104ab1) | Keep source, finding and explanation together; separate small metadata from readable content | One recorded Express scan with a source excerpt, rationale and explicit coverage rows. No invented findings or copied sample data. |
| [1Password developer documentation](https://mobbin.com/sites/sections/a89e05aa-c41c-4cf8-b196-9af59035b98d) | Directly named documentation destinations and concise descriptions | Canonical docs CTA plus coding-agent, MCP and CI links. |

Also inspected Mobbin sections for Bird, GitHub Security, Canva Developers,
PayPal, Slack, Miro, Frontify and Sui, and the public 1Password developer,
Snyk and Socket sites. Search results are semantic matches: a Snyk query returned
GitHub and 1Password, not a verified Snyk library item.

The user's final direction supersedes earlier copper/charcoal styling: homepage
backgrounds are black, text white or neutral gray, borders neutral. Verdict meaning
is textual. Navigation, headings, labels and controls share the system monospace
stack; longer explanations use the system sans-serif stack. Spacing follows an
8px base with 12px/20px intermediate gaps. Panels share 18px corners, controls 8px.
Mobile retains the same hierarchy, collapses evidence to one column, puts copying
below the command, and retains at least 44px heights on primary controls.

## Hero ownership

Read `../prototypes/pkgx-ascii-hero/README.md` before changing integration. The
completed HeyClicky job handed off that bundle to Codex for integration and left
`website/` untouched. Its source files and preview are preserved byte-for-byte.

- `assets/pkgx-ascii-hero.js` and `.css` are relative symlinks to that source.
  There is no second renderer or copied implementation.
- `home.css` owns containment, monochrome treatment, common corners, and mobile
  display sizing. At narrow widths the original renderer keeps a 560px logical
  grid so letter strokes do not collapse; its canvas fits the visible viewport.
- `app.js` maps mobile pointer coordinates into that same grid. It also freezes a
  captured frame for pause/reduced motion; it does not reconstruct the lettering.
- Reduced motion blocks pointer changes and the original renderer settles. Manual
  pause freezes visible output, although the unchanged prototype's RAF continues
  in the background. Stopping that loop would require a lifecycle API from its owner.
- Semantic heading/image text provides the accessible equivalent. With JavaScript
  disabled, a plain text fallback remains and inert controls stay hidden.

The symlinks work when serving this checkout. A future authorized deployment must
resolve them into the release artifact or arrange an agreed source relocation;
copying only `website/` without resolving symlinks would break the hero. This is a
release-packaging constraint, not a request to duplicate its source now.

## Recorded evidence and quick start

`assets/evidence/express-4.21.0.json` is a clearly labelled excerpt of the supplied
capture `pkgxray-website-handoff-2026-11-08/express-4.21.0-scan.json`. Retained scanner
fields are unchanged. Capture metadata identifies omitted fields and includes
the SHA-256 of the complete original report. Full package contents, machine-local
paths, registry contact metadata and timings are omitted from the website excerpt.

The page cites `lib/view.js:81` at Express tag `4.21.0`. The result is SAFE / allow,
with 15 source files scanned, no skipped/truncated files, completed source and OSV
checks, direct dependencies not requested, and provenance absent. Some inputs were
cached. It is not a current safety recommendation or a dependency-wide clearance.

The pinned command was checked against current README/docs, CLI parsing, npm
registry metadata, and an actual successful run from `/tmp` on 2026-11-08:

```sh
npx --yes pkgxray@1.2.1 guard npm:express@4.21.0
```

It returned SAFE / ALLOW, exit 0. Node.js 18+ and network access are required.
Canonical docs: <https://github.com/adamsjack711-ux/pkgxray/blob/main/docs/README.md>.
The checkout's own package version remains unchanged.

## Validation and review boundary

`check-home.mjs` checks recorded evidence, neutral homepage colors, use of the
original renderer, static glyph invariance, pointer response at desktop/mobile
sizes, reduced motion, pause/resume, and clipboard success/denial. It is a Node
simulation of the renderer's drawing and DOM interaction contracts, not a browser
layout engine.

Dia QA covered desktop and 320px/400px mobile layouts, no horizontal page overflow,
keyboard skip-to-content and animation control, mouse/keyboard copying, and actual
reduced-motion emulation. Browser canvas sampling found no changed bright letter
pixels while the background changed. Reduced-motion canvas snapshots stayed equal
across time and pointer movement. No real mobile device or screen-reader session
was used. Legacy favicon and social image assets remain unchanged pending logo work.

Calibration pages, their shared `styles.css`, `_headers`, scanner code, Compose Ray,
and unrelated work are outside this change. Recheck git status before any edit:
README/logo work is concurrent.

Before **any** commit, push or deployment, prepare the exact release diff (including
new assets and symlink handling), confirm the current branch and target, and obtain
user approval. At this review the branch is `fix/evaluation-review-workflow`; the
existing configuration identifies Cloudflare Pages project `pkgxray`, public domain
`pkgxray.ca`, and static output `website/`. These are recorded configuration values,
not authorization to deploy.

## Latest check results — 2026-11-08

- Website validator: passed (8 HTML pages, 4 calibration runs).
- Homepage contract tests: 5 passed. JavaScript syntax and diff whitespace checks passed.
- Actual pinned quick start: SAFE / ALLOW, exit 0.
- `npm run test:docs`: 6 passed, 3 failed, 1 skipped on the latest concurrent tree.
  The failures expect the previous README wordmark path, HTML-formatted README
  links (the current concurrent README uses Markdown links), and an immutable
  fixture-download URL pattern in the existing BLOCK walkthrough. These inputs
  and tests were not changed by the website work. The fixture-pattern failure
  existed before the concurrent README update; the other two appeared after it.
- Preservation hashes match for all baseline protected files except README.md,
  which was edited concurrently outside this website task. The new concurrent
  `docs/pkgxray-readme-hero.svg` was also left untouched.

## Files

| File | Role |
| --- | --- |
| `index.html` | Homepage content, evidence and metadata |
| `home.css` | Neutral homepage layout and typography |
| `app.js` | Copying, motion control, mobile pointer integration |
| `check-home.mjs` | Focused evidence and interaction checks |
| `assets/pkgx-ascii-hero.*` | Symlinks to the original HeyClicky component |
| `assets/evidence/express-4.21.0.json` | Recorded scan excerpt |
| `styles.css`, `stats/` | Preserved calibration site |
| `_headers` | Preserved security and cache headers |
