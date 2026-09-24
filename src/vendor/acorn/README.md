# Bundled Acorn parser

Acorn 8.18.0 is an MIT-licensed third-party JavaScript parser from
https://github.com/acornjs/acorn. `acorn.js` is copied unchanged from the npm
archive recorded in `provenance.json`. Its SHA-512 archive integrity was checked
before copying; no package installation or lifecycle scripts were run.

This is a bundled third-party component, even though pkgxray has no npm runtime
dependency installation. Keep LICENSE and provenance with the parser, including
inside the browser bundle. Updating it requires reviewing upstream changes,
checking archive integrity, updating the file SHA-256 and running the parser,
resource-limit, calibration and browser-parity tests. Do not edit the vendor file.
