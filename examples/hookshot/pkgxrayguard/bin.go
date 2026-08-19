package pkgxrayguard

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// standardBinDirs are the package-manager install prefixes searched when the
// pkgxray executable is not on PATH. They are the directories a normal login
// shell would already have in PATH — nothing is added that a user's shell would
// not have found on its own.
//
// This matters because a hook does not run in a login shell. An agent launched
// from a desktop app inherits a minimal PATH (often just /usr/bin:/bin), so a
// Homebrew or npm-global install of pkgxray is invisible to it. Under the
// default balanced policy an unrunnable pkgxray is UNKNOWN, and UNKNOWN denies
// — so a working install of both tools still blocks every package the agent
// touches, with an error that reads like a supply-chain finding.
var standardBinDirs = []string{
	"/opt/homebrew/bin", // Homebrew, Apple silicon
	"/usr/local/bin",    // Homebrew Intel, manual installs, npm default prefix
	"/opt/local/bin",    // MacPorts
	"/usr/bin",
	"~/.local/bin",       // pipx, npm --prefix ~/.local, cargo-style layouts
	"~/.npm-global/bin",  // the documented npm global-prefix relocation
	"~/.bun/bin",         // bun
	"~/.volta/bin",       // volta
	"~/.asdf/shims",      // asdf
	"~/.nvm/current/bin", // nvm's stable symlink, when present
}

var (
	resolveOnce sync.Once
	resolved    string
)

// ResolveBin returns the pkgxray executable to run.
//
// An explicit setting wins: a name containing a path separator is used
// verbatim, so PKGXRAY_BIN=/opt/pkgxray/bin/pkgxray is never second-guessed. A
// bare name is looked up on PATH first, and only if that fails are the standard
// install prefixes searched, in order. If nothing is found the original name is
// returned unchanged, so the caller still produces its usual "executable not
// found" error rather than a silently different one.
//
// The search is deliberately a fixed list rather than a scan: the result is
// executed, so widening it to arbitrary or caller-supplied directories would
// turn a PATH miss into an execution primitive.
func ResolveBin(name string) string {
	if name == "" {
		name = "pkgxray"
	}
	if name != "pkgxray" {
		return resolveNamed(name)
	}
	// The default name is resolved once per process: every package in a command
	// asks for it, and the answer cannot change mid-run.
	resolveOnce.Do(func() { resolved = resolveNamed(name) })
	return resolved
}

func resolveNamed(name string) string {
	if filepath.Base(name) != name { // an explicit path — use it as given
		return name
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, dir := range standardBinDirs {
		cand := filepath.Join(expandHome(dir), name)
		if isExecutableFile(cand) {
			return cand
		}
	}
	return name
}

// expandHome replaces a leading ~/ with the user's home directory. A path that
// does not start with ~/ is returned unchanged, and if the home directory
// cannot be determined the entry is left unexpanded so it simply fails to match.
func expandHome(p string) string {
	if len(p) < 2 || p[0] != '~' || p[1] != '/' {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return p
	}
	return filepath.Join(home, p[2:])
}

// isExecutableFile reports whether path is a regular file with an execute bit
// set. Directories and non-executable files are rejected so a stray name match
// is never handed to exec.
func isExecutableFile(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	return fi.Mode().Perm()&0o111 != 0
}

// ChildEnv returns the environment for a pkgxray child process: the hook's own
// environment with the standard install prefixes appended to PATH, plus any
// extra KEY=VALUE entries given.
//
// Resolving the pkgxray executable is not enough on its own. pkgxray ships as a
// `#!/usr/bin/env node` script, so running it also requires node on PATH — and
// a hook launched from a desktop app has neither. The child then exits 127,
// which is neither pkgxray's block (2) nor its review (3) code, so it lands on
// UNKNOWN and the balanced policy denies. The visible result is a gate that
// blocks every package with an error where a verdict should be, on a machine
// where both tools are installed and working.
//
// Existing PATH entries keep priority: the standard prefixes are appended, not
// prepended, so this only adds directories that were missing and never shadows
// a binary the host deliberately put first.
func ChildEnv(extra ...string) []string {
	env := os.Environ()
	out := make([]string, 0, len(env)+len(extra))
	replaced := false
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			out = append(out, "PATH="+augmentPath(strings.TrimPrefix(kv, "PATH=")))
			replaced = true
			continue
		}
		out = append(out, kv)
	}
	if !replaced {
		out = append(out, "PATH="+augmentPath(""))
	}
	return append(out, extra...)
}

// augmentPath appends the standard install prefixes that are not already
// present in path. Entries that do not exist on this machine are skipped, so
// the result stays as short as the host actually warrants.
func augmentPath(path string) string {
	present := make(map[string]bool)
	var parts []string
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			continue
		}
		if !present[dir] {
			present[dir] = true
			parts = append(parts, dir)
		}
	}
	for _, dir := range standardBinDirs {
		dir = expandHome(dir)
		if present[dir] || !isDir(dir) {
			continue
		}
		present[dir] = true
		parts = append(parts, dir)
	}
	return strings.Join(parts, string(filepath.ListSeparator))
}

func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}
