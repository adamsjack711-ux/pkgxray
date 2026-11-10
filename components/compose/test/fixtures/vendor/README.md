# Real-package regression fixtures

`ms-2.1.3` contains the unchanged `index.js` and `package.json` from an existing
local installation of `ms@2.1.3`. Its MIT license is retained as `LICENSE`.
`provenance.json` records hashes of the copied files and the existing lockfile
integrity field. The upstream archive was not independently downloaded or
authenticated; the integrity field is metadata, not a verification claim.

Tests and the real-package demo copy these bytes to disposable fixture trees.
They parse the code with compose-ray and never import, install, or execute it.
The numeric-formatting cases exercise supported paths. Regex parsing and unknown
environment input must remain incomplete until their semantics are modeled.

This small, selected fixture does not measure general npm coverage or accuracy.
