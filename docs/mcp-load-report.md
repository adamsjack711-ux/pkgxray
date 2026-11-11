# Measured MCP shared-analysis and runtime load

This is a historical measurement record under the earlier manual-review
contract. The numeric results below are unchanged and do not benchmark the
unpublished breaking 2.0 candidate. The 1.3 work remains a separate held PR.

In the candidate, gates run without prompts: eligible transient required checks
retry once within their shared deadline against the same immutable evidence;
unresolved uncertainty blocks with reasons. Guard/batch OSV checks and narrowly
eligible supplied-evidence worker failures own their retries. Disabled or malformed
checks, heuristic findings, unsupported coverage and permission gaps do not retry.
Proceed/Decline, session approval endpoints and optional result screening are
removed. Receipt reuse remains artifact/policy/build bound; cold first use still
waits for clearance. Daily re-audits, cache warming and agent recovery are planned,
not implemented. See [the candidate contract](review-contract.md).

## Historical runtime validation on 2026-11-10

The then-current review/upgrade workflow was exercised through real newline-delimited
stdio MCP on this Mac Studio. `node scripts/check-mcp-runtime.js` runs inert
source, shared-cache, 25-caller, review-plan, path-denial, and Compose probes.
Add `--live` to fetch and inspect pinned `npm:ms@2.1.3` with npm/OSV checks;
it never installs the package or runs its lifecycle scripts. Network/cache
timings vary; this is a smoke check rather than a production latency claim.

This run found and fixed an MCP redaction bug: the scanner-authored
`assessment.checks.source` and `approval.checks.source` statuses were replaced
with `<redacted>`. Recognized statuses at those exact paths now survive, while
source text, snippets, and similarly named fields elsewhere remain redacted.
The regression covers both raw-source confidentiality and wire-visible status.

The separate one-round load rerun is saved in
[`benchmark/mcp-load-validation-2026-11-10.json`](../benchmark/mcp-load-validation-2026-11-10.json).
It used the review-workflow build before the redaction-only correction, Node
v26.8.2, local inert fixtures, and no network. Historical three-round data below
is preserved in its original file. Selected whole-batch timings from the new run:

| Scenario | Requests | Batch time | Underlying scans | Overload replies |
| --- | ---: | ---: | ---: | ---: |
| Identical cold source | 100 | 94.282 ms | 1 | 0 |
| Identical cached source | 100 | 65.294 ms | 0 | 0 |
| Distinct cold source | 100 | 509.053 ms | 36 | 64 |
| Mixed cached/distinct source | 100 | 505.731 ms | 36 | 14 |

All 78 scan errors were explicit expected queue-overload responses. The
fixture runtime matrix processed 1,913,795 total requests including static
cases, with assertions for unknown-tool denial and poisoned-result withholding.
These are tiny in-memory fixture calls, not realistic package-scan throughput.
This matrix uses the standard runtime proxy; credential reuse is separately
covered by `test/session-secrets.test.js` and the real-proxy test in
`test/mcp-proxy.test.js`. No user approval or package promotion was issued.

## Historical measurements

These measurements were captured locally using inert fixtures. No production services were used. They predate the follow-up audit fixes below and are not fresh performance measurements of those fixes.

## Historical verification

Consolidation validation (2026-11-10, base `8d73ac3`): **1,005 tests; 1,000 passed, 5 skipped, 0 failed**, plus **18 VM unit tests and 7 folder-report CLI tests passed**. Lint and browser/website engine parity checks pass. This preserves the newer VM opt-in, read-only MCP guard, mandatory provenance/coverage holds and total transport deadlines while adding caller-specific reviews and shared-snapshot lifetime handling. No real VM guest execution or Socket comparison was performed in this validation. The five skips cover a live registry download, published-package documentation smoke test, Windows-only installer rejection, and two real Sigstore/archive verification cases.

The calibration corpus retains 36/36 malicious BLOCK results and zero false blocks across 48 benign cases; 22 benign cases still require REVIEW. The 180-case synthetic adversarial baseline has zero SAFE misses and zero false blocks. The 20-case synthetic holdout still places all 10 malicious cases in REVIEW rather than BLOCK. These are regression checks, not independent real-world accuracy estimates.

At the time, the next engineering priority was: build a detection-quality workbench around these existing runners, with versioned case manifests, independently reviewed labels, per-rule review-burden reporting and reproducible before/after comparisons. Use those measurements to improve cross-file and obfuscated flows before adding more runtime features. Later modules can cover package-version behavior diffs and cross-tool agent sequences, sharing the same evidence and policy contracts.

Follow-up audit validation: **885 tests; 883 passed, 2 skipped, 0 failed**, plus **7 folder-report CLI tests passed**. Four reproductions now verify administrator-recheck revocation, scanner-build drift rejection, cancellation before triage writes, and escaped CLI errors. Additional regressions cover in-flight scans, persisted recheck blocks, unchanged reviews, session isolation and temporary-file cleanup. Run `npm test` and `node --test examples/folder-report/checks/cli.test.cjs` for current validation; these recorded counts describe the older contract.

Original benchmark-run validation:

`npm test`: **879 tests; 877 passed, 2 skipped, 0 failed**. The added tests cover 100 simultaneous audit requests, 100 guard requests, immutable evidence, caller-specific cancellation, last-caller worker termination, deadlines, queue saturation/recovery, errors, cache TTL/build/analysis changes, per-call policy updates, action/destination isolation, and actual promotion refusal after Decline or changed bytes. Cancellation during promotion preparation preserves the previous destination and removes temporary copies.

Both 100-request cold MCP tests assert exactly one underlying `auditEvidence` execution. Guard preparation is still per request, bounded to four active jobs. A review choice is never present in the raw shared-analysis cache. Runtime enforcement remains request-specific.

## Method and scope

Measured 2026-11-07T20:47:22.018Z on Apple M1 Max, darwin arm64, Node v26.8.2. Three independent rounds per case; **96 batches**, **5,589,363 requests** total. Each case starts a fresh child host. Each sustained runtime case lasts at least five seconds and makes at least 1,000 requests; at most the selected 1/5/25/100 callers are outstanding. There were no concurrent regression tests during this recorded run.

- **Fixture-only static matrix:** real newline-delimited JSON-RPC over stdio into the production MCP audit tool, bounded shared coordinator, real worker-thread analyzer, per-call policy evaluation, and JSON replies. The inert package has a manifest and a roughly 2 KiB JavaScript source file. Cold callers use identical bytes; warm cases pre-scan those bytes; distinct cases change source bytes; mixed cases alternate warm identical and cold distinct sources. No package code is executed. This is the supplied-evidence tool path, not a registry download benchmark.
- **Fixture-only runtime matrix:** real stdio transport through production `runMcpProxy`, its bidirectional frame queue, manifest/call enforcement in `McpGate`, an inert child MCP server, and per-response result scanning. Policy is strict, result scanning enabled, recheck/pinning disabled. Every tenth call names an unknown tool. The poisoned-result fixture returns inert prompt-injection text for otherwise valid calls. Every reply is asserted against the expected allow/deny decision and checked for leaked poisoned text. Static analyzer scan counts stay zero on this path.
- **Stubbed-network results:** no new runs in this matrix. The earlier `benchmark/team-latency-results.json` is a separate historical archive/OSV-stub benchmark, not a 100-request estimate.
- **Real-network results:** not run. No registry, advisory, production MCP, HTTP/SSE, TLS, or remote transport timings are claimed.

Whole-batch wall time includes completion of every submitted request. Per-request latency starts before writing its JSON-RPC frame and ends after parsing its reply. Table latency/throughput/CPU values are medians of the three round-level values, not percentiles pooled across rounds. Queue depth and RSS are maxima across rounds. Counters are shown as ranges if they vary. Throughput counts all replies, including explicit overload rejections; raw JSON also reports completion throughput excluding errors. Latency percentiles include fast rejections, so a low p50 under overload is not evidence of scan capacity.

CPU is process user+system CPU (including analyzer worker threads), excluding the benchmark client and runtime fixture child. Peak RSS is the process high-water mark, including startup, not just a sampled interval. Runtime counters/queue peaks include handshake; cold scan counts and cache-hit counts exclude warm-up. Measurement includes the lightweight runtime telemetry callback. No CPU profile was taken.

## Static MCP measurements

| Case | Callers | Batch ms | p50 ms | p95 ms | p99 ms | Replies/s | Scans | Cache hits | Rejected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold | 1 | 59.346 | 59.259 | 59.259 | 59.259 | 16.850 | 1 | 0 | 0 |
| warm | 1 | 1.366 | 1.361 | 1.361 | 1.361 | 732.265 | 0 | 1 | 0 |
| distinct | 1 | 58.324 | 58.319 | 58.319 | 58.319 | 17.146 | 1 | 0 | 0 |
| mixed | 1 | 1.499 | 1.491 | 1.491 | 1.491 | 667.223 | 0 | 1 | 0 |
| cold | 5 | 62.274 | 62.214 | 62.237 | 62.237 | 80.290 | 1 | 0 | 0 |
| warm | 5 | 5.242 | 3.770 | 5.198 | 5.198 | 953.781 | 0 | 5 | 0 |
| distinct | 5 | 118.929 | 70.570 | 118.884 | 118.884 | 42.042 | 5 | 0 | 0 |
| mixed | 5 | 55.154 | 5.071 | 55.101 | 55.101 | 90.655 | 2 | 3 | 0 |
| cold | 25 | 67.231 | 66.851 | 67.021 | 67.037 | 371.853 | 1 | 0 | 0 |
| warm | 25 | 17.359 | 16.987 | 17.184 | 17.207 | 1440.158 | 0 | 25 | 0 |
| distinct | 25 | 368.185 | 223.625 | 349.826 | 368.043 | 67.901 | 25 | 0 | 0 |
| mixed | 25 | 174.182 | 15.785 | 173.570 | 173.962 | 143.528 | 12 | 13 | 0 |
| cold | 100 | 87.282 | 85.671 | 86.677 | 86.805 | 1145.707 | 1 | 0 | 0 |
| warm | 100 | 61.795 | 34.278 | 61.233 | 61.340 | 1618.242 | 0 | 100 | 0 |
| distinct | 100 | 517.190 | 44.573 | 463.322 | 516.439 | 193.352 | 36 | 0 | 64 |
| mixed | 100 | 496.976 | 55.938 | 440.253 | 494.389 | 201.217 | 36 | 50 | 14 |

| Case | Callers | CPU ms | Peak RSS MiB | Peak queued | Peak active scans | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold | 1 | 79.886 | 75.609 | 0 | 1 | 0 |
| warm | 1 | 2.512 | 75.609 | 0 | 1 | 0 |
| distinct | 1 | 79.356 | 75.563 | 0 | 1 | 0 |
| mixed | 1 | 2.609 | 74.875 | 0 | 1 | 0 |
| cold | 5 | 90.056 | 78.672 | 0 | 1 | 0 |
| warm | 5 | 11.275 | 75.625 | 0 | 1 | 0 |
| distinct | 5 | 393.291 | 133.750 | 1 | 4 | 0 |
| mixed | 5 | 148.587 | 98.563 | 0 | 2 | 0 |
| cold | 25 | 103.523 | 80.297 | 0 | 1 | 0 |
| warm | 25 | 24.572 | 75.547 | 0 | 1 | 0 |
| distinct | 25 | 1814.645 | 146.078 | 21 | 4 | 0 |
| mixed | 25 | 895.354 | 139.719 | 8 | 4 | 0 |
| cold | 100 | 157.031 | 86.672 | 0 | 1 | 0 |
| warm | 100 | 74.532 | 75.281 | 0 | 1 | 0 |
| distinct | 100 | 2628.278 | 152.203 | 32 | 4 | 64 |
| mixed | 100 | 2641.069 | 143.203 | 32 | 4 | 14 |

All static errors in these measurements were explicit fail-closed capacity rejections. All three 100-caller cold batches performed exactly one analyzer scan; all warm batches performed zero. No timings were extrapolated from the earlier approximately 30 ms single-scan result.

## Runtime MCP measurements

| Pattern / fixture | Callers | Requests per round | Batch ms | p50 ms | p95 ms | p99 ms | Replies/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| burst / benign | 1 | 1 | 0.484 | 0.475 | 0.475 | 0.475 | 2068.252 |
| burst / poisoned-result | 1 | 1 | 0.652 | 0.645 | 0.645 | 0.645 | 1533.742 |
| sustained / benign | 1 | 79773–81112 | 5000.030 | 0.060 | 0.092 | 0.123 | 16176.140 |
| sustained / poisoned-result | 1 | 70359–71096 | 5000.022 | 0.067 | 0.103 | 0.134 | 14154.552 |
| burst / benign | 5 | 5 | 0.947 | 0.760 | 0.922 | 0.922 | 5279.368 |
| burst / poisoned-result | 5 | 5 | 1.427 | 1.178 | 1.394 | 1.394 | 3504.569 |
| sustained / benign | 5 | 260590–265640 | 5000.055 | 0.090 | 0.146 | 0.205 | 52745.617 |
| sustained / poisoned-result | 5 | 212907–214238 | 5000.118 | 0.113 | 0.179 | 0.233 | 42807.786 |
| burst / benign | 25 | 25 | 2.129 | 1.538 | 2.040 | 2.077 | 11744.897 |
| burst / poisoned-result | 25 | 25 | 2.914 | 1.948 | 2.808 | 2.866 | 8580.132 |
| sustained / benign | 25 | 336572–342521 | 5000.306 | 0.366 | 0.506 | 0.604 | 68031.149 |
| sustained / poisoned-result | 25 | 259096–262339 | 5000.402 | 0.480 | 0.642 | 0.743 | 52219.437 |
| burst / benign | 100 | 100 | 5.311 | 3.383 | 5.005 | 5.183 | 18829.587 |
| burst / poisoned-result | 100 | 100 | 6.176 | 4.071 | 5.878 | 5.985 | 16192.693 |
| sustained / benign | 100 | 358808–361818 | 5001.344 | 1.395 | 1.760 | 2.042 | 72110.806 |
| sustained / poisoned-result | 100 | 270862–274434 | 5001.757 | 1.862 | 2.259 | 2.567 | 54675.385 |

| Pattern / fixture | Callers | CPU ms | Peak RSS MiB | Peak queued | Enforced denials per round |
| --- | ---: | ---: | ---: | ---: | ---: |
| burst / benign | 1 | 0.687 | 54.938 | 0 | 0 |
| burst / poisoned-result | 1 | 0.890 | 55.094 | 0 | 1 |
| sustained / benign | 1 | 3250.052 | 73.703 | 0 | 7977–8111 |
| sustained / poisoned-result | 1 | 3286.472 | 75.094 | 0 | 70359–71096 |
| burst / benign | 5 | 1.711 | 55.328 | 4 | 0 |
| burst / poisoned-result | 5 | 2.443 | 54.891 | 4 | 5 |
| sustained / benign | 5 | 5235.443 | 95.406 | 4 | 26059–26564 |
| sustained / poisoned-result | 5 | 5240.314 | 89.484 | 4 | 212907–214238 |
| burst / benign | 25 | 4.651 | 57.094 | 18 | 2 |
| burst / poisoned-result | 25 | 5.219 | 57.219 | 24 | 25 |
| sustained / benign | 25 | 5364.387 | 103.453 | 24 | 33657–34252 |
| sustained / poisoned-result | 25 | 5367.900 | 104.234 | 24 | 259096–262339 |
| burst / benign | 100 | 9.495 | 57.734 | 90 | 10 |
| burst / poisoned-result | 100 | 9.900 | 57.531 | 90 | 100 |
| sustained / benign | 100 | 5371.177 | 136.766 | 99 | 35880–36181 |
| sustained / poisoned-result | 100 | 5365.768 | 140.156 | 99 | 270862–274434 |

Runtime transport errors and overload rejections were zero in these cases. Expected security denials are counted separately. Every runtime response assertion passed: **zero unauthorized tool releases or poisoned-result leaks observed**. Static benchmark requests are read-only; actual promotion authorization and cancellation are verified by the tests rather than inferred from throughput.

## Bottlenecks and remaining gaps

- The distinct-artifact capacity ceiling is deliberate: four active plus 32 queued analyses admit 36 of 100 simultaneous cold distinct requests; the remaining 64 fail closed. In the 50%-warm mixed case, 50 hits plus 36 scans complete and 14 requests are rejected. Callers need bounded retry/backoff; the benchmark does not retry rejected requests.
- Inspection of the path identifies worker startup/teardown, JSON serialization, input hashing, and runtime-file generation checks as costs. Warm cache hits still check runtime files and serialize evidence. The measured cold and warm batch costs are not pure analyzer CPU timings. Their individual shares were not profiled. There is no persistent worker pool.
- Guard preparation is bounded separately but still acquires, verifies, extracts, and collects evidence per caller. The 100-request guard correctness test covers this real local path, but the timing matrix isolates the supplied-evidence static tool. Large archives, registry downloads, real advisory feeds, and acquisition cancellation latency remain unmeasured. Existing acquisition HTTP/process timeouts still apply; cancellation can await those operations before their workspace cleanup completes, while their admission slot stays occupied.
- Sharing is process-local. One stdio server represents one trusted caller/session. Multi-user gateways must establish separate trusted session identities; caller-supplied developer-name strings are not authentication. Separate stdio processes do not share analysis caches, and there is no distributed lease or cross-process single-flight protocol.
- Runtime results use tiny deterministic text responses. They do not establish throughput for large binary/resource payloads, complex real tools, remote latency, dynamic manifest revalidation, pin storage, OS sandbox overhead, or long-duration memory stability. Five-second sustained rounds are load checks, not a long soak.
- On-disk scanner/rules changes fail closed until process restart. Policy changes are read on each MCP request and revalidated before promotion. Cached evidence has a 60-second TTL, count/byte limits, and no human authorization. V8 heap limits are not a hard total-process RSS limit.
- Promotion has a defined commit point: a cancellation before the atomic rename leaves the destination unchanged; cancellation after an already authorized commit does not roll the action back.

## Reproduce

```sh
npm test
npm run benchmark:mcp-load
```

`PKGXRAY_BENCH_ROUNDS=1..10` controls repetition (default 3). Machine-readable results, including p50/p95/p99, throughput, CPU percentage, heap/RSS, scan/cache counts, queue depth, errors, rejections, and runtime enforcement counters for every round: `benchmark/mcp-load-results.json`. The harness instrumentation travels over a separate local IPC channel; production MCP does not expose test telemetry methods.
