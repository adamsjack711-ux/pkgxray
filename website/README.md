# pkgxray website

Marketing site for [pkgxray](https://github.com/adamsjack711-ux/pkgxray),
served from this directory of the main repo. Live at
<https://pkgxray.ca/>.

Monochrome ASCII hero and recorded scan evidence, synchronized with the production
homepage from the website mirror. Static files only, no homepage build step.
The public MCP section links the hosted endpoint, client guide, source and limits.
The live cold scanner accepts public npm packages and GitHub repositories at
<https://pkgxray.ca/#cold-scan>. It downloads source as data into a browser Web
Worker and runs the bundled pkgxray static engine. Package code is never installed
or executed. This is not the experimental VM service.

Bare npm names resolve a published tag (default `latest`); GitHub references
resolve to an immutable commit. Reports include npm archive SHA-256 and verified
SHA-512/SHA-256 registry integrity when available, or commit-pinned Git blob
identities. OSV lookups run separately. Findings, coverage gaps, resolved identity,
and duration can be downloaded as JSON. Results are always REVIEW or BLOCK, never
installation approval. Transitive dependencies and provenance signatures are not
checked; native and unrecognized formats are skipped and reported.

Downloads go directly to npm, GitHub and OSV, which receive the visitor's IP and
requested reference. No credentials are sent and no scan report is stored by
pkgxray. Each request has a 12-second deadline. The UI terminates its worker after
60 seconds or on cancellation. Caps: 8 MiB compressed, 32 MiB expanded, 5,000 tree
or archive entries, 100 source files, 128 KiB per file, 1 MiB source text. Browser
API support and upstream CORS/rate limits can prevent completion. No clean
result is claimed for a failed scan.

When changing the engine, run `npm run build:website-scanner` from the repository
root. Commit the generated `scanner/engine.mjs` with its preserved bundled
licenses. CI verifies parity and runs deterministic hostile archive, reference,
integrity, coverage, and detection tests: `node --test website/test/*.test.mjs`.

> **Canonical source.** This directory is the source of truth. The separate
> [`pkgxray-site`](https://github.com/adamsjack711-ux/pkgxray-site) repo is a
> deploy mirror and must be synced *from here* (copy `index.html`, `app.js`,
> `home.css`, `styles.css`, `_headers`, `validate.mjs`, `check-home.mjs`, `test/`,
> `stats/`, `scanner/`, and `assets/`, then run `node stats/build.mjs` and
> `node validate.mjs` in the mirror). Do not edit the mirror by hand.

## Local preview

```bash
cd website
python3 -m http.server 8799
# open http://localhost:8799
```

Run the zero-dependency site checks (including regenerating calibration pages)
from the repository root:

```bash
npm run validate:website
```

## Deploy

Direct upload to the Cloudflare Pages project `pkgxray`:

```bash
npx wrangler pages deploy . --project-name=pkgxray
```

Custom domains attach under the project's **Custom domains** tab in the
Cloudflare dashboard.

The `_headers` CSP keeps scripts, workers and media local. Network connections
are restricted to the site, npm registry, GitHub API/raw source, and OSV. Google
Fonts' stylesheet and font origins are allowed. `img-src data:` supports the SVG noise
texture embedded in `styles.css`; no inline script, `unsafe-inline`, or
`unsafe-eval` exception is used.

## Contents

| File | Role |
|------|------|
| `index.html` | Single scrollable page (incl. OG/Twitter card meta) |
| `styles.css` | Warm + x-ray theme |
| `app.js` | Beam, stats, scan demo, copy, verdicts |
| `assets/hero.mp4` | Slowed, smoothed CLI recording |
| `assets/poster.jpg` | Video poster still (BLOCK frame) |
| `assets/og.jpg` | 1200×630 social-share card image |
| `assets/hero.gif` | Fallback still |
| `assets/favicon.svg` | Tab icon |
| `_headers` | Cloudflare security / cache headers |
