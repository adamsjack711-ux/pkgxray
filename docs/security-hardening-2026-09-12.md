# Security hardening — 2026-09-12

This is the first-pass record. See the [subsequent parser and confinement pass](flow-analysis-and-confinement.md) for the current results and limitations.

This pass addresses the local security scan of the current working tree. Changes
are local and uncommitted; no release or deployment was performed.

## Implemented controls

- **MCP child environment:** the runtime proxy now uses the connect-time
  allowlist and controlled executable resolution. Repeatable `--env NAME` selects
  required variables without putting their values in command arguments. Missing
  variables and runtime injection overrides are rejected before child startup.
  Closing the child pauses host input so the proxy can terminate cleanly.
- **Cache SSRF:** metadata and both tarball paths validate every redirect against
  configured origins and HTTPS policy. DNS answers are checked in the socket's
  lookup callback, preventing a separate lookup from bypassing validation.
  Private/HTTP upstream access needs `--allow-private-upstream` and remains
  confined to configured origins. Malformed redirects produce controlled errors.
- **Cache credential isolation (additional finding):** token-bearing metadata
  previously entered shared storage and request deduplication. Such requests now
  bypass both, return `private, no-store`, and cannot consume public cached
  responses. Anonymous metadata uses `github/public-repos-v2`; old mixed-trust
  metadata is never read. Error responses are not cacheable. Existing old files
  are preserved on disk for operator-managed cleanup.
- **Release boundary:** validation, publishing and post-publish checks run in
  separate jobs. Only publishing gets OIDC and the existing npm token. There is
  no checkout in that job. It verifies SHA-256 and publishes the exact checked
  tarball with lifecycle scripts disabled. Unexpected self-guard exits now fail.
- **Detection:** flat credential destructuring and literal environment reflection
  produce REVIEW hints. Literal reflection of public properties avoids an
  unnecessary hint. Browser output has been rebuilt and parity checked. The
  literal NUL in the MCP pin validator was replaced with its equivalent escape
  so source inventory can inspect the file as text.

## Verification

- Full suite: **767 tests; 765 passed, 0 failed, 2 skipped**.
- Regression tests cover child startup secrets and explicit opt-ins; cross-origin
  redirects in metadata, cached tarballs and live streams; private and mixed DNS
  answers; malformed redirects; and concurrent authenticated/anonymous clients.
- Calibration: 70 cases, 29/30 malicious BLOCK and one REVIEW, no malicious SAFE
  or benign BLOCK. These results describe the synthetic corpus only.
- Challenge: 180 cases; malicious SAFE **12 → 6**, malicious REVIEW **45 → 51**,
  malicious BLOCK unchanged at 33; all 90 benign cases remain SAFE.
- Former holdout: 20 cases; malicious SAFE remains 4, malicious REVIEW remains 6;
  benign REVIEW **3 → 2**, benign SAFE **7 → 8**. No benign BLOCK.
- Browser/Node parity passes for all 270 calibration/challenge fixtures.
- Release YAML parses and privilege boundaries were inspected. Local npm pack
  and tarball-publish dry-run used a fixture with lifecycle hooks: no hook ran.
  Package dry-run contains 36 files and excludes local agent configurations.
- `git diff --check` passes.

Reproduce:

```sh
node --test --test-reporter=tap --test-timeout=30000
node benchmark/run.js
node benchmark/adversarial/run.js --check-baseline
node benchmark/adversarial/run.js --holdout --check-baseline
npm pack --dry-run --ignore-scripts
```

Default adversarial diagnostics still exit nonzero because known SAFE misses
remain. CI now ratchets against `hardening-results.json` and
`hardening-holdout-results.json`; original result files and corpus labels remain
available for comparison. The former holdout informed this work and should now
be treated as a regression set.

## Remaining limits

Ten synthetic SAFE misses remain: dynamic import of fetched code and shell key
upload (three variants each), plus template interpolation, reassigned aliases,
destructured requests and cross-file flows. The detector remains a bounded
lexical heuristic, without AST scope resolution or inter-module data flow.
Six cases moved to REVIEW, which permissive review policies may still accept.

The MCP proxy is not an OS sandbox. The child can still read accessible files,
use the network and misuse explicitly supplied credentials. Dedicated process
identities, filesystem isolation and egress policy are separate controls.

The release workflow has not been executed on GitHub. Protected release refs,
workflow review and npm trusted-publisher/account configuration remain external
controls. The existing npm token is confined to the publish step; it was not
removed or replaced. The self-guard still permits its documented REVIEW exit,
with a visible warning, because pre-publication provenance is unavailable.
