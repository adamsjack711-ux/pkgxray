# At-scale validation — top-1000 npm packages

The [calibration benchmark](../benchmark/) proves the detection engine on a
curated corpus of labelled fixtures. This harness proves the **"0 heuristic
false blocks on the top-1000 most-downloaded packages"** claim at scale, against
real packages nobody wrote as a test. Scope of the claim: [docs/benchmark.md](../docs/benchmark.md#scope-of-the-claim-read-this-first).

## 2026-07-19 revalidation (current)

The earlier run below ranked by **depended-upon count** from a fixed
[2019-ish gist](https://gist.github.com/anvaka/8e8fa57c7ee1350e3491). A fresh run
ranked the top-1000 by **real last-week download counts** (npmrank pool →
`api.npmjs.org/downloads`) as of 2026-07-19:

| metric | result |
|---|---|
| packages scanned | 1000 |
| **heuristic false blocks** | **0** (after the retune below) |
| correct known-CVE blocks | 3 — `elliptic@6.6.1`, `request@2.88.2`, `xlsx@0.18.5` |
| review / safe / scan-error | 661 / 334 / 1 |

**One false block was surfaced and fixed.** `registry-url@7.2.0` (100M+
downloads/wk) blocked on `credential-access` — it reads `.npmrc` **only** to
parse the `registry` URL, with no `_authToken` reference and no network egress.
Root cause of the miss: this package was **not in the depended-upon list** the
earlier validation used, so the `.npmrc` heuristic (which predates that run) was
never exercised against it. Fix: an `.npmrc` read with no auth-field reference
and no network sink is now `INFO`, not a block; `registry-url` is a committed
benign fixture (`benchmark/corpus/benign/npmrc-read-for-registry-url.json`) so
the gate covers it. **Lesson: rank the validation list by the metric the claim
is about (downloads), and refresh it — a stale list hides real false blocks.**

The full per-package results for this run live in the batch-scan workspace
(`~/pkgxray-scan/results/top1000/`) with the calibration writeup at
`~/pkgxray-scan/reports/calibration.md`.

## Earlier run (2026-07-11, depended-upon snapshot — history)

The [calibration benchmark](../benchmark/) proves the detection engine on a
curated corpus of labelled fixtures. This harness proves the false-block
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

## MCP cohort (separate figures, never merged)

The published calibration numbers are npm-centric, and the README concedes the
MCP/agent-tooling ecosystem is over-blocked without giving a number. This
cohort exists to measure that number — **separately**. MCP results live in
their own out-dir and their own stats artifact; they are never folded into the
top-1000 / npm figures.

The target list comes from the **official MCP Registry**
(`registry.modelcontextprotocol.io`). It holds latest versions of active servers,
npm packages only, with duplicates removed, and it is sized for one scan pass.
Entries are collected in registry cursor order up to the cap, because the
registry has no download ranking, and the file is sorted by identifier so diffs
stay stable. It records inputs only, names and versions, and no verdicts:

- [`mcp-registry-targets.txt`](mcp-registry-targets.txt) — the list
- [`mcp-registry-targets.meta.json`](mcp-registry-targets.meta.json) — source,
  fetch date, counts, regeneration command

```bash
node scripts/build-mcp-target-list.js       # refresh the list from the registry

node scripts/validate-at-scale.js \
  --cohort mcp --list validation/mcp-registry-targets.txt \
  --emit-stats validation/results/mcp/stats.json --run-id $(date +%F)-mcp
```

Results land in `validation/results/mcp/` (report + jsonl as above). The
`--emit-stats` artifact has the exact shape of `website/stats/data/<runId>.json`:
false-block figures from the scan, catch-rate figures from
`node benchmark/run.js --json --cohort mcp` (fixtures tagged `"cohort": "mcp"`
in the committed corpus — today a small denominator, reported as-is). Nothing
publishes automatically: review the artifact by hand, then copy it into
`website/stats/data/` and rebuild the stats site.

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

`review` is **not** a false positive either. It is the middle tier, and it exists
for governance and provenance signals: a single maintainer, missing provenance, a
build artifact that diverges from git, a dual-use URL shortener in an error link,
and so on.

## The corpus

[`top1000.txt`](../src/data/top1000.txt) is the canonical "most depended-upon" ranking
([source](https://gist.github.com/anvaka/8e8fa57c7ee1350e3491)). It is a fixed,
committed snapshot, so runs are reproducible. Some entries have been unpublished
since, and they show up as `error`.

## Feeding results back into the engine

Every genuine false block this surfaces becomes a **benign fixture** in
`benchmark/corpus/benign/`, so the calibration gate in CI locks the fix in
permanently. The top-1000 run that prompted this harness turned up 22 false
blocks across about 7 detectors:

- dual-use link shorteners
- shell-completion installers
- transform test fixtures
- a decode and an `eval` sitting together in a minified bundle
- build artifacts that diverge from git
- example IPs and license URLs in comments
- deleted repos

Each one was calibrated and captured as a regression fixture.
