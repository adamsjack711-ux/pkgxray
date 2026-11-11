# Broader live package cohort

`benchmark/broad-live-cohort-2026-11-11.json` freezes 32 project-selected established-package candidates before scanning. These labels are selection assumptions, not certified benign ground truth. A vulnerability or other supported security finding can justify blocking a selected package. This small convenience sample is neither a prevalence sample nor a production accuracy estimate.

The first four entries retain the exact versions and SHA256 pins of the original live controls: escape-string-regexp, is-number, picocolors, and yocto-queue. The additional 28 names were fixed before registry acquisition or scanner evaluation. They are grouped to broaden source patterns, without selecting on scanner outcomes:

| Stratum | Selected packages |
| --- | --- |
| Utilities (12) | Original four; ms, is-plain-obj, ansi-regex, strip-ansi, escape-html, fast-deep-equal, once, wrappy |
| Larger libraries (8) | lodash, minimatch, semver, glob, debug, chalk, commander, uuid |
| Framework and tooling (6) | react, express, typescript, vite, esbuild, rollup |
| Network and native (6) | undici, axios, ws, tar, sharp, @modelcontextprotocol/sdk |

## Identity acquisition

`scripts/acquire-broad-live-cohort.js` requests the original controls' exact registry versions and resolves each additional package's `latest` metadata once successfully. It then pins the returned exact version, registry archive URL, registry `dist.integrity`, compressed byte count, and SHA256. Archive retries reuse the resolved coordinates; they never consult the mutable tag again. The strongest supported SHA512/SHA384/SHA256 integrity digest must match. Original-control SHA256 values must also match their existing pins.

All requests require HTTPS at `registry.npmjs.org`, with no redirects, alternate origins, credentials, query parameters, or content encoding. Metadata is capped at 1 MiB and each compressed archive at 8 MiB. Each case has one shared 30-second deadline, at most two attempts per resource for transient failures, and acquisition runs four cases at a time. Archive hashes are streamed; archives are neither retained nor extracted. No package code, install scripts, imports, dependency installations, or scanner calls occur during acquisition.

Every selected name remains in the manifest. An acquisition failure retains any identity fields already resolved plus a bounded error code; it does not trigger replacement or a larger download budget. Such cases remain acquisition errors in subsequent reporting and must not be counted as completed scans or approvals. Provenance and dependencies are not assessed during identity acquisition; later scanner check coverage must be reported separately.

## Reproduction

Use the checked-in manifest for scans. Its `latest-at-acquisition` label records how the frozen version was selected; it is not an instruction to resolve latest again. Record the SHA256 of the exact manifest bytes alongside scanner build and policy identities in every measurement. Keep transport errors, acquisition errors, incomplete checks, valid blocks, and allows distinct.

Run the fixed broader cohort through the real stdio MCP guard:

```sh
node scripts/check-broad-controls.js --live
```

The runner accepts no alternative manifest or tool-policy flags. It exits nonzero for an invalid or incomplete measurement; valid blocks are reported without failing the measurement. Direct dependency and provenance scans are not requested, and their actual check states remain visible. `rawVerdict` records what the public MCP surface exposes, which can describe uncertainty as `inconclusive`. Per-request wall time includes registry/OSV network and MCP processing, excludes identity acquisition and session initialization, and is not a performance benchmark.

To reproduce the acquisition procedure as a **new dated cohort**, run:

```sh
node scripts/acquire-broad-live-cohort.js NEW_OUTPUT.json
node --test test/broad-cohort-acquisition.test.js
```

The output path must not exist. A new acquisition can select different latest versions and therefore cannot replace this frozen cohort or be represented as a rerun on the same inputs. The script reserves its output before network activity and only writes the complete manifest after every selected case finishes. An interrupted acquisition can leave an empty reserved output; this is not a valid frozen manifest and must not be scanned.

## Observed result on 2026-11-11

`benchmark/broad-live-validation-2026-11-11.json` records **11 allows, 21 blocks,
and zero errors** through the real stdio MCP server. The original four controls
still allow. Every artifact matches its frozen SHA256, every allowance passes
the shared authorization-receipt predicate, and no explicit override is used.
The detector build remains
`6ef8d992d9e1790b67edbe16cf8fa73384a04e24343ce7067509e52b238c5a7a`
and every case has policy SHA256
`1b862ea46776e7067d7aeb8634089c6cb36bc6b70b824df4ce16b25cc797d217`.

| Stratum | Allowed | Blocked | Errors |
| --- | ---: | ---: | ---: |
| Utilities | 10 | 2 | 0 |
| Larger libraries | 1 | 7 | 0 |
| Framework and tooling | 0 | 6 | 0 |
| Network and native | 0 | 6 | 0 |

All 32 vulnerability checks completed with zero reported vulnerabilities. All
21 blocked cases expose raw `inconclusive` through MCP. Twenty contain
`flow-analysis-gap`, nine have incomplete source coverage, and eight contain
`unresolved-runtime-execution`; these groups overlap. The remaining block,
fast-deep-equal, has install-hook and npm-versus-GitHub-divergence findings.
These observations are not adjudicated false positives or confirmed malicious
packages. They show that the original four-control success does not establish
quiet operation across this broader set.

The next investigation should focus on flow-analysis coverage and runtime-target
classification. Coverage diagnostics include unresolved build-script targets in
glob and tar, `cjs/MyComponent` in React, declaration-file targets in several
larger packages, and a computed Node target in esbuild. Lodash and the MCP SDK
reach the existing 600-file cap; Vite also reports the 1 MiB execution-graph file
limit. These diagnostics need source-level adjudication and adversarial tests
before changing detection or budgets. No thresholds or policies were relaxed
for this measurement.

Observed request times have a 1.54-second median and a 30.94-second maximum;
the sum is 204.53 seconds. They include registry/OSV and other default enrichment,
varying package sizes, and MCP processing, and exclude session initialization
and cohort acquisition. This single sequential run is not a production latency
benchmark. Direct dependency scanning was not requested, and provenance status
varied, so the result does not establish complete dependency-closure verification.

## Follow-up source and flow corrections

The runtime source planner now follows parsed import syntax instead of treating
every import-shaped string or comment as executable. This removes React's
diagnostic `MyComponent` example from its required files. Genuine imports,
subprocess targets, missing install/prepare scripts, escaping paths, parser
failures and budget limits remain coverage obligations. Explicit nested type
conditions stay separate from runtime exports; declaration-looking filenames
can still contain executable code and are not exempt by extension.

Ignoring string literals requires separate accounting for string execution.
Evaluator aliases, reflective handoffs, constructor chains, VM source and inline
Node source retain explicit uncertainty unless a bounded syntax proof establishes
inert source. The proof parses source text without running it, accepts a small
grammar and retains existing size/work limits. Paired tests keep passive examples
and supported inert probes clear while holding nested executable loads.

An unresolved module specifier now produces a flow-analysis gap and preserves
its taint. This closes the reduced false-SAFE path documented in
[the malware evidence investigation](broad-malware-evidence.md). Unknown plugin
targets remain uncertainty, not positive malware findings.

A separate readonly-arguments experiment was **not integrated**: it did not
clear `once` and introduced a new hold in the pinned `debug` control. Class-model,
accessor and work-budget gaps in `chalk` and `semver`, and general string-table
decoding, remain further work. No policy threshold, package exception or increased
resource limit was used to improve the cohort score.

### Follow-up live measurement

`benchmark/broad-live-cycle2-2026-11-11.json` reruns the same frozen manifest on
build `55657cd98d98382d629627c8a4c6703f0a1a778c84d56f94d9f916dff8bf4f40`.
Every case retains its artifact identity and prior allow/block decision:
**11 allow, 21 block, zero errors**. All four original controls still allow, all
32 vulnerability checks complete with zero reported vulnerabilities, and the
effective policy remains unchanged. No explicit override is used.

React's source coverage becomes complete, while its separate flow-analysis gap
still blocks approval. Seven already-blocked packages move from complete to
partial source coverage: fast-deep-equal, chalk, commander, uuid, express, axios
and sharp. The net source-partial count rises from nine to 15. Diagnostics include
computed module/execution targets, evaluator uncertainty, and declaration or
README files currently selected as runtime targets. The latter expose remaining
classification work; this run does not establish that those data files execute.
Flow-analysis gaps remain on 20 packages. The result demonstrates a corrected
React path and more explicit coverage limits, **not an improved approval rate**.
