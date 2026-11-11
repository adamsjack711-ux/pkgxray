# Build and MCP tracking log

Started: 2026-11-08T13:35:32.964Z

Built a dependency-free, read-only folder inventory CLI. First implemented JSON inventory, then added readable output, largest-file ranking, argument validation, and configurable entry limits. Existing Package X-Ray changes were preserved.

## Observed calls

- Initial source audit: **REVIEW**, source **scan**, 75.85 ms.
- Enhanced source audit in the same server session: **REVIEW**, source **scan**, 73.66 ms. Changed source caused new analysis.
- Ten concurrent identical enhanced-source audits: **10 cache hits**, all retained REVIEW.
- Local guard: **pending REVIEW**, no approval choice, no promotion.
- Dependency manifest audit: **0 dependencies**. Advisory lookups disabled; this does not certify the application.

Totals: **14 successful tool calls**, **3 underlying analyses** (initial source, changed source, guard with additional evidence), **10 cache hits**, **0 scan errors**, **0 overload rejections**. The session closed after the checks. No background monitoring is scheduled.

## Verification

Six CLI tests passed. The tool was exercised only against its own source directory and disposable test fixtures.

## Open finding

- Category: `flow-analysis-gap`
- File: `index.js`
- Scanner rationale: Sensitive-flow analysis is incomplete: unmodeled executable semantics (CallExpression). The cited location requires review.
- Citation: `n) || { extension, files: 0, bytes: 0 }; group.files++; group.bytes += stat.size; extensions.set(extension, group); files.push({ path: relative, bytes: stat.size })`

This needs investigation in the analyzer before claiming completed behavioral coverage. The tool was not automatically approved, promoted, or installed. Its known functional limitation is best-effort traversal of a changing filesystem, not an atomic or adversarially isolated snapshot.

Full machine-readable tool responses: `checks/mcp-results.json`.
