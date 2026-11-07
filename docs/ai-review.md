# Optional Package X-Ray AI reviewer

The deterministic scanner remains the fast, authoritative path. `pkgxray guard … --ai-review` opts into a second pass for a non-BLOCK result (including SAFE scans when the caller explicitly opts in). The reviewer runs asynchronously through a bounded in-process queue (2 active, 8 waiting); identical artifact/context/model/prompt requests are coalesced and cached in memory for 10 minutes. It selects the package entry point first (then files associated with medium findings), up to 3 code files and 36 lines per file, and sends no more than 12 KiB of excerpts. Known secret-shaped tokens and common labeled secret assignments are redacted, but redaction is not a guarantee that arbitrary source is safe to disclose.

The CLI requires `PKGXRAY_REVIEW_ALLOW_SOURCE_SUBMISSION=1` as a separate consent gate. The gate is not enabled in this checkout. Do not set it or run a live review until the package-source scope and live-call budget are approved.

The model returns candidate findings with exact source IDs, line numbers, and quotes. The CLI revalidates every citation against the excerpt, ignores model severity, labels accepted candidates `medium`, and folds them through the deterministic verdict function. AI can add a REVIEW hold; it cannot clear scanner findings, issue BLOCK, or create/replace an artifact or caller approval. Static BLOCK never calls the reviewer. A missing URL, failed call, timeout, cancellation, or overload is visible in `aiReview.status` and leaves the static decision intact. The grade/score remains the static scanner's score.

## Local CLI configuration

Set these only after approving the source-data scope and setting up the Render service:

- `PKGXRAY_REVIEW_URL` — service base URL (the client appends `/v1/review`)
- `PKGXRAY_REVIEW_API_TOKEN` — same long bearer secret configured on the service
- `PKGXRAY_REVIEW_MODEL` — model identity used for cache isolation; match `OPENAI_MODEL` on the service
- `PKGXRAY_REVIEW_ALLOW_SOURCE_SUBMISSION=1` — explicit source-sharing gate
- `PKGXRAY_REVIEW_TIMEOUT_MS` — optional request deadline; default 8000 ms

`OPENAI_API_KEY` is never read by the CLI. It belongs only in the Render service's secret environment.

## Render service settings

Create a **Web Service** with public HTTPS access in the existing **Package X-Ray** project after the local branch is approved, published, and connected. The CLI needs to reach the hosted endpoint; Render private services are not reachable from a user's laptop. The bearer-token-protected review route is exposed publicly, while the health endpoint is intentionally public. No service is deployed or published by this work.

| Setting | Value |
|---|---|
| Repository | `https://github.com/adamsjack711-ux/pkgxray` |
| Branch | `ai-reviewer/local-integrated` (local only; not selectable yet) |
| Root directory | `review-api` |
| Runtime | Node |
| Build command | `npm install --omit=dev` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Listener | `0.0.0.0:$PORT` (Render-assigned) |

Environment-variable names for Render (no values are stored in this repository):

- `OPENAI_API_KEY` — required server-side OpenAI secret
- `OPENAI_MODEL` — the exact OpenAI model name to use; required, with no guessed default
- `PKGXRAY_REVIEW_API_TOKEN` — required 32+ character bearer secret; also set locally for the CLI
- `PKGXRAY_REVIEW_ENABLED` — set `false` initially; the route refuses model calls until explicitly enabled
- `PKGXRAY_REVIEW_MAX_CALLS_PER_DAY` — set `0` initially; choose a positive cap only after approval
- `PKGXRAY_REVIEW_TIMEOUT_MS` — optional server request deadline; default 12000 ms

The daily request cap is process-local (resets on service restart), not a dollar guarantee. The service also bounds input bytes, output tokens, response size, concurrency, and request time. Configure an OpenAI project spend limit separately before approving live calls.

## What was checked

The existing private Tapp backend is a distinct application. Its current server exposes an authenticated Tapp Responses API, but does not expose a package-review route. Its request policy is built around Tapp's account/quota/tool contract, so this implementation leaves it untouched and adds a dedicated service under `review-api/` instead. The source review did not read or expose any secret values. `OPENAI_MODEL` is required rather than inheriting that backend's default; choose a model explicitly before a live test.

## Offline verification

`npm test` runs local tests only. The review API tests inject a fake OpenAI transport; the CLI integration test uses a local HTTP server and synthetic fixture code. Neither path calls OpenAI or sends package source off-device.
