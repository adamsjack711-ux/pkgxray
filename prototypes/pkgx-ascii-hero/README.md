# pkg X-Ray ASCII hero prototype

An isolated, local-only source bundle for the approved monochrome hero concept. This folder is not wired into the website or build; it does not change the canonical site, README, runtime, or package behavior.

## Files

- `index.html` — standalone preview page.
- `pkgx-ascii-hero.css` — namespaced rounded-panel, field, and footer styles.
- `pkgx-ascii-hero.js` — canvas character field, static ASCII wordmark, wave animation, and pointer response.

## Behavior

- The `pkg x-ray` letter silhouette is rendered from bright `@` characters and stays fixed in position and brightness.
- The dimmer ASCII field flows behind and between the letters, animates, and reacts to pointer movement.
- The CSS/JS use `.pkgx-ascii-hero` class names; there are no external assets, fonts, or runtime dependencies.
- The page-level centering styles live only in `index.html`; the component stylesheet is namespaced for easier integration.

Codex can use this prototype as the visual and implementation reference when integrating the hero into the canonical website. No website files were edited by adding this prototype.
