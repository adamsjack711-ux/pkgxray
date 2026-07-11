# At-scale validation — top-1000 npm packages

The [calibration benchmark](../benchmark/) proves the detection engine on a
curated corpus of labelled fixtures. This harness proves the **"0 false blocks"**
claim at scale, against real packages nobody wrote as a test: it runs
`pkgxray guard` over the 1,000 most-depended-upon npm packages and reports how
many get wrongly blocked.

## Run it

```bash
node scripts/validate-at-scale.js                 # full top-1000 (~4-6 min)
node scripts/validate-at-scale.js --limit 100     # quick sample
node scripts/validate-at-scale.js --concurrency 8 --timeout-ms 40000
```

Outputs to `validation/results/`:
- `report.md` — human-readable summary (the headline table + any false blocks)
- `results.jsonl` — one JSON record per package (decision, grade, findings, timing)

Exit code is `0` iff **heuristic false blocks == 0**, so CI can gate on it.

## What counts as a false block

The gate is deliberately precise. A `block` decision is only a **false block**
when it is *heuristic-driven on a genuinely-benign package*. Three block classes
are **not** false blocks and are reported separately:

- **known-CVE blocks** — the package has a published OSV vulnerability. Blocking
  it is correct; pkgxray must never allow a published vuln away.
- **defensible blocks** — the package genuinely performs the flagged high-risk
  operation (see [`defensible-blocks.json`](defensible-blocks.json); e.g. `pm2`
  installs systemd/init boot persistence via its documented `pm2 startup`
  feature). These are true positives a security team *should* review. The list
  is committed and audited — it must never be used to hide a real false positive.
- **errors** — the package no longer resolves (unpublished/renamed since the
  corpus snapshot). Recorded as `error`, never as a block.

`review` is **not** a false positive either — it is the by-design middle tier for
governance/provenance signals (single-maintainer, missing provenance, a build
artifact diverging from git, a dual-use URL shortener in an error link, …).

## The corpus

[`top1000.txt`](top1000.txt) is the canonical "most depended-upon" ranking
([source](https://gist.github.com/anvaka/8e8fa57c7ee1350e3491)). It is a fixed,
committed snapshot so runs are reproducible; some entries have since been
unpublished and show up as `error`.

## Feeding results back into the engine

Every genuine false block this surfaces becomes a **benign fixture** in
`benchmark/corpus/benign/` so the calibration gate in CI locks the fix in
permanently. The top-1000 run that motivated this harness turned up 22 false
blocks across ~7 detectors (dual-use shorteners, shell-completion installers,
transform test-fixtures, minified-bundle decode/eval co-location, build
artifacts diverging from git, example IPs and license URLs in comments, deleted
repos); each was calibrated and captured as a regression fixture.
