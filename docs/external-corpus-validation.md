# External static corpus validation

`node scripts/validate-external-corpus.js` evaluates a fixed historical cohort
from the DataDog dataset revision pinned in the script, plus four exact-version
benign controls with pinned artifact hashes. Selection finishes before any
scan. Acquisition and scan errors remain in the results; no failing sample is
replaced. The harness never installs, imports, or executes package code.

The results distinguish the raw analyzer verdict from the automatic guard's
decision. Raw `review` means unresolved evidence, not confirmed malicious
behavior. Network enrichment is disabled in this experiment, so a guard block
can also reflect missing checks. A small, selected corpus is not an independent
accuracy certification or a prevalence estimate.

## Live MCP contrast

`node scripts/check-live-controls.js --live` checks the same four pinned benign
controls through the current checkout's real stdio MCP server, with npm and OSV
checks enabled. It never installs or executes the target packages. Each allow
must have a valid authorization receipt bound to the expected artifact, current
scanner build and assessment policy, with consistent checks and authorization.
Explicit overrides remain visible in the output. Errors retain their original
selected case; they cannot count as allows.

`measurementValid` describes the measurement contract, while
`allControlsAllowed` describes the observed outcomes. A valid run containing a
block exits successfully but reports `allControlsAllowed: false`; an invalid
measurement exits nonzero. These four controls do not measure malicious recall,
production false-positive prevalence, or latency. The command requires `--live`
so an accidental invocation does not start network checks.

## Primitive getters and internal linked state

The flow model supports an instance getter whose entire body returns one
declared private field. Reads retain the field's lexical identity and require a
matching instance brand and a modeled primitive value. Unsupported accessors,
ambiguous receivers, descriptor changes and unresolved cross-method effects
retain uncertainty.

For dormant methods, a bounded proof can describe private linked data whose
values come only from a local, non-escaping class with declared plain data
fields and inert constructor writes. Every relevant assignment and alias must
fit the proof. External assignments, factories, binding ambiguity, escaping
links and reflective mutations do not qualify. The possible data shape is
merged only into the isolated dormant receiver; it never replaces actual
instance state or its taint. This is not general JavaScript class modeling.

`node --test test/getter-adversarial.test.js test/private-field-shape.test.js`
checks the supported controls and conservative boundaries. Follow it with the
live command above to verify actual approvals under the current policy.

## Archive selection and limits

The ZIP reader accepts a regular file of at most 4 MiB with at most 512 members.
Every central-directory member must retain its original name (including no NUL
truncation) and undergoes path, Unicode/case collision, duplicate,
file/directory overlap, and file-type checks, including members not selected for
extraction. Links and special files are rejected. A pre-existing destination is
never replaced or followed.

If there is exactly one original TGZ, the reader selects that archive. Otherwise
it requires one unambiguous outer `package/` subtree with `package.json` and
materializes the **entire subtree**, including non-code runtime resources. It
does not select files by extension or by detector findings. It does not treat
sibling dataset metadata outside this root as published package content.

The unchanged 16 MiB expanded-byte limit applies to the selected TGZ or complete
package subtree, both before extraction using declared sizes and while streaming
actual bytes. A selected gzip stream also retains its 64 MiB expansion limit.
Unselected contents are never decompressed or CRC-validated. Each case reports
selected and ignored member counts and declared byte totals, with
`unselectedContentValidated: false`; the report does not claim that all ZIP
contents were inspected. The Python subprocess has a 15-second deadline.

Derived-tree files are written without execute permission into a private working
directory. Extraction failure removes the partial destination, and evaluation
removes its entire working directory in a `finally` block. Original ZIP hashes
identify the corpus inputs; a derived-tree hash does **not** establish the
original npm tarball's identity.

## Solana extraction-limit regression

The previously selected `@solana/web3.js@1.95.7` sample is unchanged:

- Dataset revision: `df32a361b27b78c5de4cdb4b4c549b666accaa40`.
- ZIP SHA-256: `9059d6e4265a83aa89f47b6254947ae147889c2bada930f67c9cc7c0521a46bb`.
- ZIP size: 3,305,138 bytes; 92 entries; 22,972,450 declared expanded bytes.
- No original TGZ is present. The complete package subtree has 78 files,
  totaling 10,881,310 bytes. Four unselected entries, including directory
  records and an external `package_info` JSON file, declare 12,091,140 bytes.

The earlier aggregate limit counted that unselected metadata and rejected the
sample before scanning. Applying the existing budget to selected content permits
the complete package tree without decompressing the external metadata. The
resulting derived-tree SHA-256 is
`75304bf3b716906fdabbfebe18a00471f798c98ea3368f9daed3576e77bcf790`.

A static check on the detector baseline `10c8672` returned raw `review` and guard
`block`, with 77 source files scanned, no skipped or truncated files, and
`sourceCoverage.complete: true`. Findings included `flow-analysis-gap`,
`missing-metadata`, and `network-access`. This resolves an extraction error; it
does not establish positive detection of the known compromise or complete
behavioral understanding. No payload was retained. The earlier benchmark JSON
remains a historical record of its failure; rerun the full fixed cohort against
the integrated scanner before drawing a new comparison.

## Regression checks

`node --test test/external-corpus.test.js` uses inert generated archives to cover
oversized ignored metadata, complete subtree resources, selected-byte and gzip
limits, compressed-input and entry limits, unsafe ignored members, duplicate and
conflicting paths, links/special files, corrupt selected content, destination
preservation, and cleanup. No executable package fixture is required.
