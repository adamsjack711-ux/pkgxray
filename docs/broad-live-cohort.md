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
