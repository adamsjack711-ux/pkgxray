# Calibration run — 2026-07-19 (reproducibility inputs)

These are the **inputs** to the 2026-07-19 calibration run published at
<https://pkgxray.pages.dev/stats/2026-07-19>. They let a third party reproduce
the run and re-derive the numbers. They contain package **names and versions
only — no verdicts**. pkgxray does not publish per-package verdicts (a public
"package → verdict" lookup would be a free detection oracle).

## Files

| file | what it is |
|---|---|
| `top1000-targets.txt` | the 1,000 `name@version` targets, one per line, resolved 2026-07-19 |
| `top1000-targets.meta.json` | same list with `downloads_last_week` and `resolved_date` per package |

The `top1000` list is the **calibration list** — the one the published false-block
rate is measured on.

## How the top-1000 list was built

1. Start from the anvaka `npmrank.json` pagerank pool (~1.0M packages).
2. Take the top ~2,600 candidates and **re-rank by real last-week download count**
   (`https://api.npmjs.org/downloads/point/last-week/<pkg>`).
3. Keep the top 1,000; pin each to the version resolved from the abbreviated
   packument `dist-tags.latest` on 2026-07-19.

The MCP hunting list (300 packages, not part of the false-block denominator) was
built from an npm keyword search over `mcp-server`, `modelcontextprotocol`, `mcp`,
capped by relevance and re-ranked by last-week downloads. Its raw form is not
published here; its construction is described on the methodology page.

## Reproduce

```sh
# per package, no execution, no hosted endpoints:
pkgxray guard npm:<name>@<version> --format json
# exit 0 = safe, 2 = block, 3 = review
```

Run that over `top1000-targets.txt` and you re-derive the verdict distribution and
the false-block count. Blocks split two ways: an **OSV block** (a real CVE — by
design, not a false positive) versus a **heuristic block** (a malware-signal
finding). Only heuristic blocks on benign packages are false positives; each was
read by hand. See the methodology page for the full adjudication.

The known-malware corpus and the benchmark harness that produces the catch-rate
number live in this repository under [`benchmark/`](../../benchmark/).

## Scope

Aggregate calibration only. This directory is inputs + method; it does not record
what pkgxray decided about any individual package.
