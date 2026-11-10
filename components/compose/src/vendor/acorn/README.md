# Bundled Acorn

Acorn 8.18.0 is an MIT-licensed JavaScript parser. `acorn.cjs` was copied byte
for byte from the trusted local pkgxray checkout's `src/vendor/acorn/acorn.js`.
Only the filename changed to preserve CommonJS loading in this ESM project.
The original license and provenance metadata are retained beside it.

The recorded SHA-256 is verified in the test suite. Upstream archive provenance
was inherited from pkgxray; this project did not independently download the
archive. No target source is passed to eval, imported or executed by the parser.

Upstream: https://github.com/acornjs/acorn
