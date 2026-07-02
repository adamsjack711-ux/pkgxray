// pkgxray × hookshot guard hook.
//
// This is a self-contained Go module meant to live inside the hookshot fork at
// examples/pkgxray-guard/. The `replace` points the hookshot import at the
// parent repo (../..), so it builds offline with no `go get` once dropped in.
// If you build it standalone (outside the fork), delete the replace line and
// run `go get github.com/CorridorSecurity/hookshot@latest`.
module github.com/CorridorSecurity/hookshot/examples/pkgxray-guard

go 1.21

require github.com/CorridorSecurity/hookshot v0.0.0

replace github.com/CorridorSecurity/hookshot => ../..
