# Automatic gate contract — unpublished 2.0 candidate

This describes the breaking 2.0 candidate in this checkout, not a published release. The 1.3 work remains a separate held PR. Final gate outcomes are binary: `SAFE` / `UNSAFE`, with `allow` / `block` decisions. No user prompt, pending approval, Proceed or Decline is part of the active flow. Raw scanner internals may still distinguish `review`; public gates map unresolved uncertainty to block with reasons. A block for incomplete checks is not a claim of confirmed malware.

## Automatic checks and bounded retries

The gate holds an immutable source or archive snapshot, runs required checks, and returns the result automatically. A narrowly eligible transient failure of a required check gets at most one automatic retry within the original shared deadline. Guard and batch vulnerability checks retry transient OSV failure against the same resolved package identity; guard's OSV budget is 15 seconds across both attempts. The supplied-evidence MCP worker path retries only its eligible transient worker failures against the same captured evidence. A retry does not download replacement bytes or reset the deadline. Proxy delivery delegates this retry to guard and adds no nested retry loop.

Disabled checks, malformed inputs, unsupported behavior, heuristic uncertainty, permission gaps and finding-bearing reports are not repaired by repeating a scan. They remain blocked with explicit reasons. Persistent transient failure also blocks. The automatic path does not relax policy, execute package code to investigate, widen permissions or ask a user to approve uncertainty.

Explicit digest-pinned declarative operator policy remains applicable to discretionary findings. It cannot clear mandatory missing source, vulnerability, provenance or behavioral evidence. This is separate from the removed per-event approval flow.

## Background operation and first use

The proxy and MCP server can run as background services. Identical concurrent work shares a bounded scan, and valid cached evidence reduces repeated work. A cold first use still waits for the necessary checks before bytes or a tool result can be released. No prompt is needed, but the gate is not bypassed while work runs.

Daily re-audits, proactive cache warming and automatic agent recovery are planned follow-ons, not implemented schedulers or services. Cache TTL expiry triggers refresh on demand; it does not schedule a daily scan. An operator may explicitly invoke the proxy administrator recheck endpoint.

## Shared proxy

The artifact gate binds approval reuse to the held archive's SHA-256, package identity, applicable policy, scanner build and completed checks. A changed hash, policy or build invalidates reuse. Concurrent callers of one proxy process share one in-flight scan. File-backed evidence survives restart; there is no session approval store. TTL expiry refreshes intelligence on the next request. Scanner failures and mandatory holds use a denial-only cache with bounded TTLs; they never authorize delivery or fall back to stale approvals. Queue pressure and caller cancellation do not become malware findings.

Unresolved requests return HTTP 403 with `decision: "block"`, `outcome: "UNSAFE"` and reasons. Authorized delivery uses `SAFE`. There is no `PENDING` outcome or HTTP 409 review exchange. The legacy `/-/pkgxray/review` endpoint returns HTTP 410 without accepting decisions; session tokens are neither issued nor consulted for approval. Old `reviewPolicy: warn|allow` inputs normalize to `block`; old `scanErrorPolicy: fail-open` normalizes to `fail-closed`.

Failed administrator rechecks revoke prior clearance. A later successful recheck permits a fresh exact-byte artifact scan; a name/version recheck alone cannot mint an artifact approval.

## Guard, CLI and MCP

CLI review flags, MCP review arguments and library review decision inputs are removed. Existing local decision files and legacy review receipts cannot authorize use, installation, promotion or delivery. Receipt reuse always requires the correct artifact, policy and scanner build plus complete mandatory evidence; raw cached findings alone are insufficient.

MCP guard remains read-only: it rejects promotion arguments and redacts package source and staging paths. Local promotion and enforced installation retain their separate authorization boundaries. Installation still verifies archive bytes and completed checks; promotion rechecks policy and cancellation before committing.

The shared scan coordinator applies to proxy artifact scans and MCP static analysis. MCP caches immutable raw reports before each caller's policy evaluation; the proxy retains policy-bound disk evidence. Standalone CLI invocations still scan independently. Multiple proxy processes do not share in-flight coordination; run one owner per cache file.

Runtime `McpGate` checks every call and result independently of static package caches. Manifest uncertainty, pin verification failure, drift and suspicious results block under `strict`, `balanced` and `permissive`. Result screening is mandatory; `--no-scan-results` is removed.

## Historical validation and latency

The measurements below were recorded under the earlier manual-review contract, before the unpublished 2.0 changes. They are preserved for comparison and do not validate current retry behavior or binary enforcement. Run `npm test` and `npm run benchmark:team` on the candidate for new results. The benchmark uses a real 26-file archive, integrity verification, extraction, static analysis, and disk verdict caching. OSV is stubbed with an empty response. It excludes downloads, external advisory latency, process startup, and human decisions. Four/five-caller results measure completion of the entire concurrent batch. Each cold batch must perform exactly one scan; cache-hit measured calls must perform zero.

Measured locally on Apple M1 Max, macOS arm64, Node v26.8.2 (20 rounds, 2026-11-10):

| Scenario | Median | p95 | Measured scans |
| --- | ---: | ---: | ---: |
| Cold scan | 36.342 ms | 51.203 ms | 20 |
| Cache hit | 0.626 ms | 0.938 ms | 0 (20 setup scans) |
| 4 concurrent callers | 38.456 ms | 44.157 ms | 20 |
| 5 concurrent callers | 35.265 ms | 38.583 ms | 20 |

Machine-readable results: `benchmark/team-latency-results.json`. These are local fixture measurements, not production registry latency estimates.


## High-traffic MCP safeguards

`src/shared-scans.js` reuses `BoundedQueue` for four active analyses and 32 waiting distinct analyses. Equivalent work joins the same job before consuming another queue slot. The service caps waiters at 512, queued/active input at 32 MiB, each analysis input at 8 MiB, and cached evidence at 128 entries/32 MiB. Evidence expires after 60 seconds. Failed/cancelled/timed-out scans never enter the cache. Workers have 128 MiB old-generation and 32 MiB young-generation V8 heap limits; these are not total RSS limits.

MCP's outer request queue admits 128 active/256 total requests and 16 MiB of frames. Before artifact identity is known, a separate use of the same coordinator admits four active/124 waiting guard preparations (16 MiB of request arguments, 60-second deadline). Preparation keys are unique per request, so staging and policy evaluation are never shared. Promotion is available only through trusted local callers, not MCP. Source collection and acquisition still run per caller; only the subsequent raw static analysis is coalesced. Analysis overload replies with JSON-RPC `-32001` and does not authorize an action or terminate the session. Static scan deadlines include queue time (30 seconds). MCP request cancellation uses `notifications/cancelled` with `params.requestId`; its controller affects only that caller. The shared worker is terminated when all callers abandon it or the job deadline expires. Running capacity is retained until termination completes. A later caller can enqueue fresh work while the old worker terminates, within the same bounds. Outer request execution has a 60-second cancellation deadline.

Static cache identity includes the exact source/evidence snapshot, verified archive digest when available, analysis configuration, and the scanner build hash (runtime code, rules/data, entrypoints, package version). Policy-only changes can reuse raw analysis but always get new policy evaluation and receipt identity. Policies are loaded per MCP call and checked again before returning the guard assessment. Local promotion also rechecks policy before committing. Changes to on-disk scanner files are detected before cache use and after analysis; the process fails closed until restarted, preventing mixed code generations. Worker startup also validates the build hash.

Approval receipts bind the artifact, applicable policy, scanner build and completed required checks. Raw analysis cache hits do not authorize installation or promotion. Every caller still passes the current authorization boundary; legacy review decisions are not consumed.

Promotion uses a private temporary sibling copy and rechecks cancellation/policy before an atomic rename. Cancellation before that commit preserves the prior destination; cancellation after an authorized commit does not undo it. Runtime tool calls and responses continue through `McpGate` individually and never consult the static package-analysis cache.

Run `npm run benchmark:mcp-load` for the full 1/5/25/100 request matrix (three rounds by default; `PKGXRAY_BENCH_ROUNDS=1..10`). The separate static and runtime paths, measurements, limits, and unmeasured areas are recorded in `docs/mcp-load-report.md` and `benchmark/mcp-load-results.json`.

## Candidate flow measurement

Run `node benchmark/automatic-flow.js` to measure the public binary policy separately from raw analyzer calibration. On the authored static corpus, this candidate blocks all 36 malicious fixtures and 22 of 48 benign controls (26 benign controls remain safe). All 22 benign stops previously returned internal REVIEW. This is a fixture-only flow cost, not a real-world error rate or an acceptable-production-flow claim. Common gaps include build hooks, dynamic/generated code, Python source coverage, and provenance divergence. A retry cannot resolve deterministic missing analysis. Automatically resolving these cases with additional bounded evidence is follow-up work; the candidate remains unpublished.

Machine-readable evidence: `benchmark/automatic-flow-validation-2026-11-10.json`, `benchmark/mcp-automatic-validation-2026-11-10.json`, and `benchmark/team-automatic-validation-2026-11-10.json`. The team benchmark uses one inert archive and a stubbed clean advisory provider; it excludes network downloads and real advisory latency.
