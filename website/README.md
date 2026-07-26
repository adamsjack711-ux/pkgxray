# pkgxray website

Marketing site for [pkgxray](https://github.com/adamsjack711-ux/pkgxray),
served from this directory of the main repo. Live at
<https://pkgxray.ca/>.

Warm CLI palette (stik-latte) with mint x-ray accents. Static files only — no build step.

> **Canonical source.** This directory is the source of truth. The separate
> [`pkgxray-site`](https://github.com/adamsjack711-ux/pkgxray-site) repo is a
> deploy mirror and must be synced *from here* (copy `index.html`, `app.js`,
> `styles.css`, `_headers`, `validate.mjs`, `stats/{build.mjs,site.json,stats.css,data/*}`,
> and `assets/{og.jpg,poster.jpg}`, then run `node stats/build.mjs` and
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

The `_headers` CSP keeps scripts and media local and allows only Google Fonts'
stylesheet and font origins. `img-src data:` is required by the small SVG noise
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
