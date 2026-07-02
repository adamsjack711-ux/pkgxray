package pkgxrayguard

import (
	"regexp"
	"strings"
)

// FileEdit mirrors hookshot.FileEdit (a single OldString→NewString replacement)
// so this stdlib-only package can diff manifest edits without importing the
// hookshot module. main.go passes ctx.Edits straight through.
type FileEdit struct {
	OldString string
	NewString string
}

// manifestEntryRE matches a JSON "key": "value" string pair, e.g. a
// package.json dependency line `"express": "^4.18.0"`.
var manifestEntryRE = regexp.MustCompile(`"(@?[A-Za-z0-9][\w.-]*(?:/[\w.-]+)?)"\s*:\s*"([^"]*)"`)

// exactVersionRE matches a pinned semver (no range operator), so we only attach
// a version to the ref when pkgxray can resolve it verbatim.
var exactVersionRE = regexp.MustCompile(`^\d+\.\d+\.\d+[\w.+-]*$`)

// nonDepKeys are package.json string fields (and common engines/runtime keys)
// whose values can look like a version but are not packages to triage.
var nonDepKeys = map[string]bool{
	"version": true, "name": true, "description": true, "license": true,
	"main": true, "module": true, "types": true, "typings": true,
	"homepage": true, "author": true, "type": true, "packageManager": true,
	"engines": true, "os": true, "cpu": true, "private": true,
	"node": true, "npm": true, "yarn": true, "pnpm": true, "vscode": true,
}

// ManifestAddedSpecs diffs a set of package.json edit hunks and returns the
// dependency specs that were added or had their version changed. Unchanged
// entries (present identically in the old text) are ignored, so an edit that
// only reformats or bumps an unrelated field re-triages nothing. Git/URL deps
// are classified as review-worthy VCS specs (same as install commands); local
// file:/link:/workspace: deps are skipped. Extraction is best-effort — callers
// should fall back to a full audit when it returns nothing.
func ManifestAddedSpecs(edits []FileEdit) []InstallSpec {
	var out []InstallSpec
	seen := make(map[string]bool)
	for _, e := range edits {
		old := parseManifestDeps(e.OldString)
		for name, val := range parseManifestDeps(e.NewString) {
			if old[name] == val {
				continue // unchanged dependency
			}
			spec, ok := manifestSpec(name, val)
			if !ok || seen[spec.Ref] {
				continue
			}
			seen[spec.Ref] = true
			out = append(out, spec)
		}
	}
	return out
}

// parseManifestDeps extracts dependency-looking "name": "spec" pairs from a
// package.json fragment, keyed by package name. Entries whose key is a known
// non-dependency field or whose value doesn't look like a version/spec are
// dropped, so `"description": "a tool"` or `"version": "1.0.0"` aren't mistaken
// for packages.
func parseManifestDeps(text string) map[string]string {
	deps := make(map[string]string)
	for _, m := range manifestEntryRE.FindAllStringSubmatch(text, -1) {
		key, val := m[1], m[2]
		if nonDepKeys[key] || !looksLikeDepSpec(val) {
			continue
		}
		deps[key] = val
	}
	return deps
}

func manifestSpec(name, val string) (InstallSpec, bool) {
	kind, ok := classifySpec(val)
	if !ok {
		return InstallSpec{}, false // local file:/link:/workspace: dep — nothing to fetch
	}
	if kind == KindVCS {
		return InstallSpec{Ref: val, Kind: KindVCS, Raw: name + "@" + val}, true
	}
	ref := "npm:" + name
	if v := strings.TrimPrefix(val, "="); exactVersionRE.MatchString(v) {
		ref += "@" + v // pin only when the spec is an exact version
	}
	return InstallSpec{Ref: ref, Kind: KindRegistry, Raw: name + "@" + val}, true
}

// looksLikeDepSpec reports whether a JSON value resembles a dependency spec (a
// version, range, dist-tag, or git/URL/protocol) rather than free text.
func looksLikeDepSpec(v string) bool {
	if v == "" {
		return false
	}
	switch v[0] {
	case '^', '~', '>', '<', '=', '*', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return true
	}
	if v == "latest" || v == "next" {
		return true
	}
	for _, p := range []string{"npm:", "file:", "link:", "workspace:", "git", "http", "github:"} {
		if strings.HasPrefix(v, p) {
			return true
		}
	}
	return false
}
