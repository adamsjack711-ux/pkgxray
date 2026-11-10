# folder-report

A small read-only CLI built while exercising the local Package X-Ray MCP server. It reports file counts, total logical bytes, file types, and the five largest files. It reads filesystem metadata, not file contents, and needs no dependencies or installation.

```sh
# From the Package X-Ray checkout:
node examples/folder-report/app/index.js examples/folder-report/app
node examples/folder-report/app/index.js examples/folder-report/app --json
node examples/folder-report/app/index.js /path/to/folder --max-entries 5000
```

The default traversal limit is 10,000 entries (files and directories); maximum 100,000. Exceeding the limit exits nonzero without printing a partial report. Symbolic links encountered during traversal and `.git`/`node_modules` directories are skipped. File names are quoted in text output so control characters cannot become terminal escapes.

This is a best-effort metadata inventory, not a filesystem security sandbox or atomic snapshot. Concurrent tree changes may affect counts or cause errors. Do not use it to enforce isolation against a tree being maliciously modified during traversal. Hard links count as separate paths and sizes are logical bytes, not disk blocks.

## Checks

```sh
node --test examples/folder-report/checks/cli.test.cjs
```

Seven tests cover nested grouping, size ranking, unchanged content, symlink/exclusion behavior, entry limits, JSON output, empty directories, invalid inputs, and terminal controls in reports and errors.

`checks/mcp-session.cjs` uses the existing local stdio test harness to call the real production MCP server. Native `pkgxray-local` tools were not exposed to the chat during this build. No registry, advisory, or production services were used.

```sh
node examples/folder-report/checks/mcp-session.cjs
# Enter commands, one per line:
# audit
# burst
# guard
# manifest
# finish
```

`burst` expects a preceding audit in the same session. The session writes its transcript to `checks/mcp-results.json`; rerunning replaces that transcript. The original pre-enhancement source snapshot is in `checks/baseline-source.json`.

## Current review status

**Pending REVIEW; not approved or promoted.** The scanner reported `flow-analysis-gap` for an unmodeled call expression. Local guard scanning also omits advisory lookups and cannot issue an eligible review approval for these local files. A successful test run is not a replacement for those checks. No Proceed choice was submitted, and no policy/rules were weakened to obtain a passing verdict.

Run `node examples/folder-report/checks/audit-repro.cjs` for the four audit regression checks. They use disposable fixtures and stubbed scanner/advisory responses, write a local `checks/audit-results.json`, and exit nonzero if any security assertion fails. Generated audit and MCP transcripts are local artifacts, not committed source.
