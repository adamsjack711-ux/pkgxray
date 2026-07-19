# pkgxray website

Marketing site for [pkgxray](https://github.com/adamsjack711-ux/pkgxray),
served from this directory of the main repo. Live at
<https://pkgxray.pages.dev>.

Warm CLI palette (stik-latte) with mint x-ray accents. Static files only — no build step.

## Local preview

```bash
python3 -m http.server 8799
# open http://localhost:8799
```

## Deploy

Direct upload to the Cloudflare Pages project `pkgxray`:

```bash
npx wrangler pages deploy . --project-name=pkgxray
```

Custom domains attach under the project's **Custom domains** tab in the
Cloudflare dashboard.

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
