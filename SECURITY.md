# Security and scope

Compose-ray is a research prototype, not a production security boundary. A
finding is evidence to review; a missing finding is not proof of safety.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/adamsjack711-ux/package-compose-ray/security/advisories/new)
for scanner execution, file access, evidence substitution, or approval-bypass
issues. Include the commit, a minimal synthetic reproducer, expected behavior,
and actual behavior. Do not attach real credentials or private source.

If private reporting is unavailable, open an issue asking for a private contact
without publishing exploit details. Ordinary unsupported syntax and false
findings can be reported publicly with inert fixtures.

## Trust boundaries

- Target source, manifests, paths, and lockfiles are untrusted data. The scanner
  parses them without invoking target code, npm scripts, or network calls.
- The host Node runtime, Compose-ray checkout, bundled parser, and explicitly
  selected pkgxray scanner are trusted code. The worker is a bounded process,
  not an OS sandbox for an untrusted scanner.
- Inputs must be stable snapshots. Path and symlink checks do not confine an
  attacker concurrently replacing parent directories.
- Only a bounded CommonJS entry path is modeled. Dynamic behavior, native code,
  unsupported syntax/APIs, other entrypoints, and later downloaded payloads may
  escape this model. Coverage is not whole-application coverage.
- Local file hashes identify analyzed bytes, not entire archives or authenticated
  registry content. Lockfile integrity is recorded but not verified here.

## Combined-mode guarantees and limits

A valid pkgxray block remains a block. Worker failures and incomplete checks
cannot yield installation permission. Original reports and gaps remain in JSON.
The adapter always sets `authorization.installAllowed` to `false`; it does not
mint pkgxray receipts.

Registry acquisition, vulnerability lookup, provenance verification, and full
package inventory are not part of this mode. pkgxray's broader workflows remain
separate. Resource bounds constrain reads, AST work, paths, traces, and worker
runtime/output; the prototype has not received an independent hostile-input audit.

Only the current main-branch prototype receives fixes. There is no supported npm
release or security response-time commitment yet.
