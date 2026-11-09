# package-compose-ray

A local research prototype that traces environment data across npm package
boundaries into modeled network calls. It complements pkgxray's individual
package analysis with an explicit source → call → sink report.

**Status: CommonJS prototype, version 0.2.1.** This is not a production security
scanner, package safety verdict, or replacement for pkgxray. The project remains
private to npm publication (`private: true`); the GitHub repository is public.

## Try it

Node.js 18 or newer is required. No dependency installation is needed; the
third-party Acorn parser is bundled with its license and provenance metadata.

```sh
npm test
npm run demo
npm run demo:real
npm run demo:strings
```

The demo creates disposable synthetic package trees and analyzes two cases:

- A token passed to another package's sender function → `review`, with the
  package identities and source, call, and network sink locations.
- A public constant passed to that same sender → `no-flow-found`.

Fixture code is never executed, installed, or downloaded. The demo deletes its
own temporary trees after analysis.

`demo:real` parses a pinned copy of `ms@2.1.3`: numeric formatting completes,
credentials alongside formatted output are flagged, and regex parsing/unknown
environment inputs remain incomplete. Package code is never executed. This is
a selected regression fixture, not a general npm accuracy benchmark.

`demo:strings` checks the formatting regressions repaired in 0.2.1:
`"Bearer " + process.env.TOKEN + " suffix"` and
`"payload=" + JSON.stringify({token: process.env.TOKEN})` now retain a
cross-package credential finding. The paired public-data examples stay clear;
custom serialization callbacks remain incomplete.

## Scan an existing source snapshot

Supply an npm v2/v3 `package-lock.json`, a matching root `package.json`, and
materialized package sources in their locked `node_modules` locations. A copied
or otherwise reviewed source tree is enough; compose-ray never runs npm install.

```sh
node bin/compose-ray.mjs /path/to/source-tree --entry index.js
node bin/compose-ray.mjs /path/to/source-tree --entry index.js --json
```

The entry is a file relative to the source root, defaulting to `index.js`.
The CLI reads files beneath that root and emits its report to stdout. It does
not execute target code, read actual environment values, or make network calls.
Source strings such as `process.env.NPM_TOKEN` are tracked symbolically.

| Result | Exit | Meaning |
| --- | --- | --- |
| `no-flow-found` | 0 | No modeled flow was found from this entry in the supported subset. This does not mean safe. |
| `review` | 1 | Environment data reaches a modeled network call. The transfer may be legitimate. |
| `incomplete` | 2 | Input, semantics, resolution or budget gaps prevent completing the analysis. Any findings already collected remain in the report. |

Invalid CLI arguments also exit 2. A finding is not a malware determination:
legitimate clients send credentials to intended services. Destination policy and
approval rules are not implemented yet.

## What works

- npm lockfile v2/v3 package-instance identities, including scoped names, hoisted
  dependencies and nested versions. Source manifest names/versions must match
  the locked instances.
- Literal CommonJS `require`, package `main`, `.js`/explicit `.cjs` files, legacy
  directory indexes, and exact string `exports` targets. A package instance is
  selected from the importing file's location, not just its name.
- `var` hoisting/redeclaration, `const`/`let` block scope, local variable assignment,
  literal properties and object/array values, function declarations/expressions/
  arrows, identifier parameters, return values and direct CommonJS exports.
- Primitive arithmetic/comparisons, conversions, selected `Math` functions,
  concatenation/templates, `typeof`, known-condition `if`/ternary branches and
  short-circuit operators. Unknown conditions explore both alternatives with
  saved/restored state and an explicit `uncertain-control-flow` gap. Such results
  remain incomplete; they do not claim to prove path feasibility.
- `process.env` sources, `fetch` arguments, Node HTTP/HTTPS request/get arguments
  and request-stream write/end sinks. `JSON.stringify(value)` preserves tracked
  data when no custom serialization callback is present.
- Primitive result types are tracked separately from their unknown contents and
  source traces. Repeated concatenation, templates, supported conversions and
  JSON formatting preserve those traces through later operations and package
  returns. An unknown call or arbitrary object does not become a modeled string.
- File/line/column evidence, import edges, source/call/return/sink traces, and
  per-instance hashes of the manifest and source files actually read.

Variable/branch semantics follow a bounded subset of the
[ECMAScript statement specification](https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html).
The resolver uses a deliberately limited subset of the documented
[npm lockfile format](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)
and [Node CommonJS resolution](https://nodejs.org/api/modules.html#all-together).
It is not a complete Node loader.

## Explicit limits

Coverage is scoped to one entry and the functions it calls. Uncalled exports,
other entrypoints, lifecycle scripts and runtime-fetched payloads are outside
that scope. The parser budgets the entire loaded module, but semantic gaps are
reported when unsupported constructs are reached on the selected entry path.
Dormant function bodies no longer prevent analysis of a supported call. Syntax
parse errors still stop that module. Unsupported reached statements produce
explicit gaps; later supported statements can still contribute findings.

These cases return `incomplete`, rather than an implied safety verdict:

- ESM/TypeScript/native modules, dynamic require, conditional/wildcard exports,
  package self-references, nested package scopes, workspace links and symlinks.
- Unknown branch feasibility, loops/switches, async/generators, destructuring,
  getters, classes, regex execution, most builtins/APIs, unknown calls, outer-scope
  writes and object mutation beyond top-level direct CommonJS exports, exceptions,
  custom object coercion/serialization, import cycles and recursive calls.
- Missing source, manifest mismatches, unlocked imported packages and exhausted
  file, graph, evaluation or output budgets.

The default bounds are 2,048 locked instances, 128 loaded modules, 256 KiB per
manifest/source file, a 2 MiB lockfile, 4 MiB total manifest/source bytes, 50,000
syntax nodes, 50,000 evaluation steps, depth 64, 100 findings, 100 gaps and 32
tracked paths per value. Alternative control flow is limited to 64 paths and
computed strings to the configured per-file size limit. The API permits lowering
these bounds.

Use a stable local snapshot. Paths are checked for traversal and symlinks, but
this is not a filesystem sandbox against another process actively replacing
parent directories during a scan. Input bytes and parser work are bounded;
this prototype has not received a hostile-input security audit.

`analyzedContentSha256` fingerprints only the recorded file list and those
files' hashes. It is **not** a hash of an entire package archive. Lockfile
integrity is reported as metadata and is **not verified** against a registry
archive. Matching a manifest name/version does not authenticate source bytes.

## Programmatic use

```js
import { analyzeProject } from './src/analyze.mjs';

const report = analyzeProject({
  root: '/path/to/source-tree',
  entry: 'index.js',
  limits: { maxModules: 64 },
});
```

The report includes `verdict`, `coverage`, `findings`, `gaps`, `packages`,
`imports`, `lockfileSha256`, resource counters and the applied limits. Analysis
input errors become structured gaps; invalid API limit options throw.

## Verification

The test suite covers the sensitive/benign pair, unused capabilities, relative
imports, nested-version selection, hoisted/scoped imports, return/object flows,
HTTP streams, var/lexical scope, branch isolation and early returns, the pinned
real `ms` numeric path, resolution limits, unsupported semantics, source identity, input
bounds, cycles, symlinks, evidence hashes, CLI behavior, and parser provenance.
Formatting regressions include repeated transformations, harmless pairs,
overwrites, returned values, unknown branches, custom coercion, serialization
callbacks/cycles, and trace deduplication without hiding budget exhaustion.
All examples use synthetic data and non-routable `.invalid` destinations.

## Confirmed boundary

In the reviewed pkgxray checkout, `src/flow-analysis.js` follows relative local
imports. Bare package imports become symbolic values rather than resolving to
the dependency's source. Supplying both modules to the engine does not close
that boundary.

The probe compares the same credential-to-network flow through two imports:

- `require("./sender.js")`: produces a `credential-export` flow hint.
- `require("sender")`: no flow hint and no coverage gap in this fixture.

Both variants also have a benign control that sends a public constant.
This establishes a limitation of the flow engine. It does not establish the
verdict of a complete package scan, and a credential flow alone does not prove
malice: an authorized service can legitimately receive credentials.

Run against a trusted local pkgxray checkout:

```sh
npm run probe -- /path/to/pkgxray/supply-chain-auditor
```

No dependencies need installing. The probe loads the supplied scanner and
passes it synthetic source strings. It never executes fixture code or makes
network requests. Exit 0 means the controls pass and the historical gap
reproduces; exit 1 means the baseline needs review; exit 2 means invalid usage.

The reviewed checkout was on `architecture/1.3-auto-resolution` at `3ff5fa5`
with additional uncommitted changes. These observations describe that local
state, not a claim about all published pkgxray versions.

## Next increments

1. Add string and regex summaries, then bounded switch/array/callback handling,
   with paired sensitive/benign cases from real packages. The existing unknown
   input scenarios for `ms`, `wordwrap` and `qs` still return incomplete.
2. Reduce noisy coverage diagnostics without hiding the first blocking reason
   or resource exhaustion. Broader traversal of complex trees can now hit budgets.
3. Add narrowly specified ESM support and bind supplied trees to verified
   archives before treating them as authenticated registry evidence.
4. Define a versioned pkgxray integration contract. One scanner's clean result
   must never erase the other's uncertainty.

No registry package or production scanner release has been published.
