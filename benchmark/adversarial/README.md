# Adversarial challenge results — 2026-09-11

September 23 audit remediation: CI now uses `audit-results.json`, retaining
`flow-results.json` unchanged as the prior snapshot. Eight additional benign
runtime entries now receive REVIEW for unsupported syntax: both Python families'
custom-extension entries, and all three `shell-key` and `powershell-key` variants.
Their labels and corpus bytes are unchanged. The only added category is
`flow-analysis-gap`. This is an acknowledged increase in review burden, not
improved malicious blocking: totals are 33 malicious BLOCK, 57 malicious REVIEW,
78 benign SAFE and 12 benign REVIEW. Calibration and former holdout verdicts
are unchanged. Per-case regression checks remain strict against this reviewed
baseline; they were not relaxed to ignore arbitrary benign overflags.

September 17 policy update: `flow-results.json` now records four benign Python
cases as REVIEW because Python behavior is not modeled. These are
`python-env/benign/{entry,test-named-entry}` and
`python-key/benign/{entry,test-named-entry}`. Labels and corpus bytes are unchanged;
the regression check still rejects every new malicious SAFE miss and benign BLOCK.
The current challenge totals are 57 malicious REVIEW, 33 malicious BLOCK,
86 benign SAFE and 4 benign REVIEW. The holdout remains 10 malicious REVIEW and
10 benign SAFE. Counts below describe earlier passes.

The original 70-case calibration benchmark was too narrow to justify strong detection-accuracy claims. This pass adds 180 paired challenge cases and a separate 20-case internal holdout. Together with calibration, 270 cases now exercise the Node/browser engines.

**This is internal testing, not independent validation.** The same assistant authored labels and detector changes. No outside reviewer has validated these labels. The fixtures are inert synthetic source strings, not downloaded malware or runnable malicious packages. Reserved `.invalid` endpoints prevent accidental use of real collection endpoints; the test harness only invokes the scanner and never executes fixture code.

## Results

| Dataset | Malicious SAFE (missed) | Malicious REVIEW | Malicious BLOCK | Benign SAFE | Benign REVIEW | Benign BLOCK |
|---|---:|---:|---:|---:|---:|---:|
| Challenge, before | 45 | 12 | 33 | 90 | 0 | 0 |
| Challenge, after | 12 | 45 | 33 | 90 | 0 | 0 |
| Internal holdout, after; no tuning on results | 4 | 6 | 0 | 7 | 3 | 0 |

The 180 challenge cases comprise **30 behavior families**, each with a malicious snippet, a benign contrast and three filename/runtime-entry variants. They are correlated observations, not 180 independent attacks. The filename variants produced identical verdicts. The holdout has 10 additional paired shapes. Its labels were written after the detector change and its results were not used to tune the detector; this still does not make it an independently authored or statistically representative holdout.

The improvement is **33 malicious SAFE → REVIEW transitions**, not 33 new blocks. REVIEW can prevent installation under a strict policy, but a policy allowing reviews can still accept these cases. Zero benign BLOCKs does not mean zero false positives: the holdout has three unnecessary REVIEWs, which can also interrupt installation.

The original 70-case calibration run remains unchanged: 29/30 malicious cases BLOCK, one REVIEW, zero malicious SAFE, zero benign BLOCK. That result describes that corpus only and must not be advertised as a real-world malware detection rate.

## What changed

`src/sensitive-flows.js` adds bounded lexical hints for credential environment values entering modeled fetch, request-stream, DNS, WebSocket, beacon and shell-curl sinks, plus remote fetch inside a VM execution call. It recognizes literal bracket access and some simple aliases. Comments, string examples and common regex literals are opaque. Its findings are MEDIUM/REVIEW because the same shape can represent legitimate authentication.

The implementation is **not an AST parser, scope resolver or data-flow engine**. It scans at most 1 MiB / 60,000 tokens, examines bounded call/assignment windows and caps inner matching work. Template interpolation is opaque; reassignment, shadowing, reflection and inter-file flow are incomplete. Reaching a heuristic budget is not evidence of safety. Other existing checks still run, but this helper does not claim exhaustive coverage.

The browser bundle includes the same helper. Parity checks compare verdict, score and every finding on all 270 fixtures. The bundler now inserts source through a replacement callback so literal `$` replacement sequences in generated code cannot corrupt it.

## Remaining misses and false reviews

Frozen challenge misses (each repeated in three entrypoint variants):

- `destructured-secret`: credential alias introduced through destructuring.
- `reflect-env`: whole environment obtained through `Reflect.get`.
- `import-fetch`: fetched source executed through a data-URL dynamic import.
- `shell-key`: curl uploads a private key without a separate filesystem-read call.

Untuned holdout misses:

- `template-interpolation`: credential in an interpolated URL.
- `reassigned-alias`: the sensitive value reaches a reassigned variable.
- `destructured-request`: destructured HTTPS request and chained `.end`.
- `cross-file`: credential source and export live in different modules.

Untuned holdout unnecessary REVIEWs:

- `computed-secret-name/benign`: a computed key selects public `NODE_ENV`.
- `callback-shadow/benign`: a parameter shadows the outer secret variable.
- `reflect-property/benign`: reflection selects public `NODE_ENV`.

The foreign-language challenge snippets probe textual heuristics through npm-declared runtime references. They are not realistic PyPI packages or proof of execution reachability. Real archive, installer and operating-system behavior remains the responsibility of separate integration tests. These cases also omit timing triggers, actual obfuscator outputs, most ecosystem-specific semantics and production-scale benign applications.

## Reproduce and enforce regressions

```bash
npm run benchmark                    # original calibration gate
npm run benchmark:adversarial        # exits 1: 12 known SAFE misses
npm run benchmark:holdout            # exits 1: 4 known SAFE misses
node benchmark/adversarial/run.js --json
node benchmark/adversarial/run.js --check-baseline
node benchmark/adversarial/run.js --holdout --check-baseline
```

The default diagnostics intentionally fail while SAFE misses or false BLOCKs remain. `--check-baseline` is a different contract: per-case malicious detection cannot weaken, benign severity cannot increase, and the corpus digest must match. CI uses that explicit ratchet and prints the known miss count. A passing ratchet is **not** a clean detection result. `before.json`, `after.json` and `holdout-results.json` retain every verdict and finding category; corpus hashes make accidental relabeling or fixture replacement visible.

## External review handoff

The next credible validation step is for an outside reviewer to author a new, separately held dataset, validate labels without seeing verdicts, and report errors grouped by behavior family. Include realistic published-archive layouts, successful benign authentication clients, full applications, unsupported language surfaces, cross-file flows and install-time behavior. Preserve misses and false reviews; do not silently relabel or delete them to improve a score. The committed cases and result JSON provide reproducible inputs for that review, but no external review has been commissioned or completed.

## Security hardening follow-up — 2026-09-12

The same frozen inputs now produce 6 challenge SAFE misses (previously 12):
flat credential destructuring and literal `Reflect.get(process, 'env')` are
recognized as REVIEW. Challenge totals are 6 malicious SAFE, 51 malicious
REVIEW, 33 malicious BLOCK, 90 benign SAFE, and no benign reviews or blocks.
The 20-case former holdout has 4 malicious SAFE, 6 malicious REVIEW, 8 benign
SAFE and 2 benign REVIEW. Literal reflection of public `NODE_ENV` now clears.

This follow-up explicitly used known results, so the 20 cases now serve as a
regression set, not an untuned holdout. Original baseline files and labels remain
unchanged; CI now ratchets against the new hardening results. `hardening-results.json` and `hardening-holdout-results.json` preserve
this run. Browser/Node parity is verified on all 270 fixtures. No additional
malicious cases BLOCK; six moved from SAFE to REVIEW.

Remaining challenge misses are `import-fetch` and `shell-key` (three variants
each). Former holdout misses remain template interpolation, reassigned aliases,
destructured requests and cross-file flow. Nested/default/rest destructuring,
computed reflection and scope resolution remain outside the lexical hint's
coverage. A proper AST and inter-module data-flow engine still needs separate
engineering and independent evaluation.

## Parser and confinement follow-up — 2026-09-12

The frozen challenge now has **0 malicious SAFE, 57 malicious REVIEW, 33 malicious
BLOCK, 90 benign SAFE**. The former holdout has **0 malicious SAFE, 10 malicious
REVIEW, 10 benign SAFE**. Both have zero benign BLOCK or benign REVIEW.
Calibration retains 29 malicious BLOCK and one malicious REVIEW. All 270 cases
have matching Node/browser findings and scores. The labels and case files were
not changed. `flow-results.json` and `flow-holdout-results.json` are the new CI
baselines; earlier results remain historical evidence.

The last ten known SAFE cases moved to REVIEW, not BLOCK. The implementation now
uses a real parser with bounded local-module and assignment analysis, plus a
shell command tokenizer for credential-file uploads. It also removes the two
remaining benign reviews involving shadowed or computed public values. Tests add
variations on source/sink aliases, named/default imports, branch/loop overwrites,
function parameters, quoted shell examples, cycles and missing modules.

These corpora informed development and no longer provide independent holdout
evidence. Passing them does not imply universal malware detection. Unknown or
unsupported language semantics and novel obfuscation remain outside these
results. The normal diagnostic commands now succeed; CI enforces both zero
misses/false blocks here and the per-case severity baseline.
