# pkgxray at-scale validation — top-1000 npm packages

Corpus: `validation/top1000.txt` · 1000 packages · concurrency 8 · 238s wall.

The gate for 1.0 is **heuristic false blocks = 0**: a `block` on a
genuinely-benign popular package driven by static/behavioral heuristics.
A block that carries a **known-vulnerability** finding is a *true* positive —
the package has a published CVE and pkgxray must never allow it away — so
vuln blocks are reported separately, not counted against the target. `review`
is by design (governance/provenance signals). Packages that no longer resolve
are `error`, never `block`.

## Headline

| Decision | Count | % of scanned |
|---|---:|---:|
| safe/allow | 621 | 62.1% |
| review | 347 | 34.7% |
| block (known-vuln, correct) | 26 | 2.6% |
| block (defensible, real capability) | 1 | 0.1% |
| block (heuristic) | 0 | 0.0% |
| error/unresolved | 5 | 0.5% |

- **Heuristic false blocks: 0** ✅ (target met)
- Correct blocks (known CVE): 26
- Defensible blocks (documented real capability, see validation/defensible-blocks.json): 1 — pm2
- Scanned: 1000 · resolved: 995 · unresolved/error: 5

## Correct blocks — known published vulnerability (not false positives)

These carry an OSV/known-vulnerability finding. Blocking them is the intended behavior.

| Package | Grade |
|---|---|
| `request` | F |
| `aws-sdk` | F |
| `fs` | F |
| `angular` | F |
| `ip` | F |
| `vue-template-compiler` | F |
| `xmldom` | F |
| `html-minifier` | F |
| `hoek` | F |
| `http` | F |
| `hapi` | F |
| `string` | F |
| `xlsx` | F |
| `elliptic` | F |
| `faker` | F |
| `lodash.pick` | F |
| `lodash.set` | F |
| `swig` | F |
| `nedb` | F |
| `babel-traverse` | F |
| `mockjs` | F |
| `showdown` | F |
| `markdown` | F |
| `node-static` | F |
| `decompress` | F |
| `quill` | F |

## Why packages land in `review` (top finding categories)

| Finding category | # of review packages |
|---|---:|
| code-execution | 303 |
| install-hook | 166 |
| npm-vs-github-divergence | 77 |
| lonely-maintainer | 74 |
| supply-chain-signal | 38 |
| environment-access | 29 |
| github-archived | 22 |
| hidden-unicode | 20 |
| network-exfil-or-loader | 14 |
| native-build | 5 |
| persistence | 4 |
| data-access | 4 |
| injection-attempt | 3 |
| remote-code-load | 3 |

## Errors (unresolved / timed out)

5 package(s) failed to resolve — typically unpublished or deprecated since the 2019 corpus snapshot. These are honest gaps, not blocks. Full list in `results.jsonl` (decision: error).

