# pkgxray × Hookshot — install-gate hardening triage

Reproduced from a clean checkout at `examples/hookshot/` against the current
hook (`main.go`, `pkgxrayguard/{parse,guard,policy}.go`). The core gate already
ships more than the task prompt assumed — several "gaps" do not reproduce.
Each row below is verified against the actual code before any PR is opened.

Legend: **confirmed** = gap reproduces, worth a PR · **partial** = already
handled, only a refinement remains · **not-a-gap** = already fully covered.

## T1 — command parser breadth

| case | command / input | current behavior | expected | status |
|---|---|---|---|---|
| npm/i/add/scoped/version/flags | `npm i -D jest lodash`, `npm install @types/node`, `npm i react@18` | resolves each ref, skips flags | same | not-a-gap |
| pnpm/yarn/bun add + global | `pnpm add x`, `yarn global add ts`, `bun add zod` | resolved | same | not-a-gap |
| npx / bunx / pnpm-dlx / bun x | `npx create-react-app`, `pnpm dlx prettier`, `npx -p esbuild ...` | resolved (incl. `-p/--package`) | same | not-a-gap |
| `claude mcp add … -- npx …` | launcher after `--` | resolved | same | not-a-gap |
| chained / quoted | `npm ci && npm i evil`, `npm i "lodash@4"` | segment-split, quote-aware | same | not-a-gap |
| **git+https / git@ / tarball URL** | `npm i git+https://github.com/x/y.git` | **silently dropped** (`isRegistrySpec`→false→omitted → command ALLOWED) | surface as **review-worthy** (pkgxray can't vet an arbitrary VCS/URL spec) | **confirmed** |
| **shape-aware fail-mode** | npx/dlx where `pkgxray` errors/times out, under `permissive` | `Unknown`→Allow (immediate-exec runs code with no verdict) | immediate-exec must **ask**, never silently allow, regardless of policy | **confirmed** |
| `npm ci` / bare `npm install` | installs whole existing lockfile, no per-pkg ref | → `nil` (pass-through) | belongs to lockfile triage (T2), not per-ref parsing | out-of-scope note |

## T2 — direct manifest / lockfile edits (`OnAfterFileEdit`)

| case | input | current behavior | expected | status |
|---|---|---|---|---|
| handler exists | edit `package.json`/`*-lock.*`/`pnpm-lock.yaml` | `auditManifest` runs `pkgxray audit <file>`, maps 2→block / 3→context | — | not-a-gap (already ships, opt-in via `PKGXRAY_HOOK_AUDIT_LOCKFILES=1`) |
| `.pkgxray.lock` memory | re-edit adding an already-approved dep | CLI `audit` honors the sibling `.pkgxray.lock` (JS test: "auditLockfile honors a pre-existing .pkgxray.lock") | no re-prompt for approved deps | partial — **verify** the hook path exercises it end-to-end |
| **diff to newly-added deps** | edit adds one dep to a large manifest | re-audits the **whole** tree every edit | triage only the added/changed deps | **confirmed** (refinement) |

## T3 — verdict memoization / cache in the hook

| case | input | current behavior | expected | status |
|---|---|---|---|---|
| **session memo** | same `ref@version` installed twice in one session | `guard.Check` shells out **every** time (~1.3–1.5s cold each) | one underlying guard call per exact `ref@version` | **confirmed** (net-new) |
| **`PKGXRAY_CACHE_URL` passthrough** | env set | hook does not forward it to the CLI | forwarded so registry/GitHub fetches collapse across runs | **confirmed** (net-new) |
| error not cached | guard errors once | n/a (no cache) | never memoize an `Unknown`/error verdict; never cross versions | design constraint |

## T4 — surface findings on deny / ask

| case | input | current behavior | expected | status |
|---|---|---|---|---|
| findings in deny msg | blocked install | `denyMessage` already renders `ref → verdict (summary)` + top-3 `[category] rationale` reasons | — | not-a-gap (already ships) |
| **`file` in reason line** | finding carries `file` (JS emits `report.findings[].file`) | Go `guardJSON` struct omits `file`; reason line has no location | include `category + reason + file` | **confirmed** (minor) |
| clean allow adds no noise | safe install | `AllowExecutionWithReason` one-liner, no findings | — | not-a-gap |

## Net-new work after triage (revised PR plan)

Much of the prompt's assumed surface already shipped. The honest remaining work:

1. **T1** — surface git/VCS/URL specs as review-worthy + shape-aware fail-mode (immediate-exec → ask on Unknown). *(medium)*
2. **T4** — thread `file` through `guardJSON` + reason lines. *(small)*
3. **T3** — session verdict memo keyed by exact `ref@version` + `PKGXRAY_CACHE_URL` passthrough; never cache errors/across versions. *(medium, net-new)*
4. **T2** — diff to newly-added deps before audit; confirm `.pkgxray.lock` memory is honored end-to-end. *(medium)*

Out of scope (issue, not PR): post-install / runtime-fetched payloads — pkgxray's
stated blind spot; the fix is install-time sandboxing in the agent, not this gate.
