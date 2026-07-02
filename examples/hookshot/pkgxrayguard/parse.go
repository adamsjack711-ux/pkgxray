// Package pkgxrayguard turns an AI agent's shell command into a set of package
// references and asks pkgxray whether each is safe to install.
//
// It has no third-party dependencies (stdlib only) so it can be unit-tested
// without the hookshot module or a network connection. The hookshot wiring
// lives in the parent main package.
package pkgxrayguard

import (
	"path"
	"strings"
)

// InstallSpec is a single package an agent is about to install/run, expressed
// as a pkgxray reference.
type InstallSpec struct {
	Ref     string // pkgxray reference, e.g. "npm:express@4.18.0"
	Manager string // "npm" | "pnpm" | "yarn" | "bun" | "npx"
	Raw     string // the original token, for messages
}

// ParseInstalls extracts the packages a shell command would fetch from a
// registry, across npm/pnpm/yarn/bun installs, npx/bunx/pnpm-dlx runners, and
// `claude mcp add … -- <launcher>` forms. It is deliberately conservative:
// unrecognized shapes yield nothing rather than a wrong reference, and local
// paths / VCS URLs are skipped because pre-install registry triage does not
// apply to them.
func ParseInstalls(command string) []InstallSpec {
	var out []InstallSpec
	for _, seg := range splitSegments(command) {
		out = append(out, parseSegment(seg)...)
	}
	return dedupe(out)
}

// splitSegments breaks a command line into independently-executed pieces on
// newlines and the shell operators && || ; and |.
func splitSegments(command string) []string {
	fields := replaceAll(command, []string{"\n", "&&", "||", ";", "|"}, "\x00")
	var segs []string
	for _, s := range strings.Split(fields, "\x00") {
		if s = strings.TrimSpace(s); s != "" {
			segs = append(segs, s)
		}
	}
	return segs
}

func replaceAll(s string, olds []string, new string) string {
	for _, o := range olds {
		s = strings.ReplaceAll(s, o, new)
	}
	return s
}

func parseSegment(seg string) []InstallSpec {
	// `claude mcp add <name> -- <launcher…>` (and similar wrappers): the real
	// package lives in the launcher command after the `--` separator.
	if i := indexToken(seg, "--"); i >= 0 {
		rhs := strings.Join(tokenize(seg)[i+1:], " ")
		if rhs != "" {
			if specs := parseSegment(rhs); len(specs) > 0 {
				return specs
			}
		}
	}

	toks := tokenize(seg)
	if len(toks) == 0 {
		return nil
	}
	bin := path.Base(toks[0])

	args := toks[1:]
	switch bin {
	case "npm", "pnpm", "bun", "yarn":
		// `pnpm dlx`, `yarn dlx`, `bun x` are runner forms, not installs.
		if len(args) > 0 && (args[0] == "dlx" || (bin == "bun" && args[0] == "x")) {
			return parseRunner(bin, args[1:])
		}
		return parseInstaller(bin, args)
	case "npx", "bunx", "pnpx":
		return parseRunner(bin, args)
	}
	return nil
}

// installSubcommands are the verbs that add named packages from a registry.
var installSubcommands = map[string]bool{
	"install": true, "i": true, "add": true, "in": true,
}

func parseInstaller(bin string, args []string) []InstallSpec {
	// Skip a leading "global" (yarn global add / bun global add).
	if len(args) > 0 && args[0] == "global" {
		args = args[1:]
	}
	if len(args) == 0 || !installSubcommands[args[0]] {
		return nil
	}
	manager := bin
	if bin == "bunx" || bin == "pnpx" {
		manager = "npx"
	}

	var specs []InstallSpec
	for _, tok := range args[1:] {
		if isFlag(tok) || !isRegistrySpec(tok) {
			continue
		}
		specs = append(specs, InstallSpec{Ref: toRef(tok), Manager: manager, Raw: tok})
	}
	return specs
}

func parseRunner(bin string, args []string) []InstallSpec {
	// pnpm's runner is `pnpm dlx <pkg>`.
	if bin == "pnpx" || bin == "pnpm" {
		if len(args) > 0 && args[0] == "dlx" {
			args = args[1:]
		}
	}
	for i := 0; i < len(args); i++ {
		tok := args[i]
		// -p/--package explicitly names the package to fetch.
		if tok == "-p" || tok == "--package" {
			if i+1 < len(args) {
				return runnerSpec(args[i+1])
			}
			continue
		}
		if v, ok := flagValue(tok, "--package"); ok {
			return runnerSpec(v)
		}
		if isFlag(tok) {
			continue
		}
		// First bare token is the package npx resolves and runs.
		return runnerSpec(tok)
	}
	return nil
}

func runnerSpec(tok string) []InstallSpec {
	if !isRegistrySpec(tok) {
		return nil
	}
	return []InstallSpec{{Ref: toRef(tok), Manager: "npx", Raw: tok}}
}

// isRegistrySpec reports whether a token is a registry package (not a local
// path, a VCS/HTTP URL, or a bare "." / "..").
func isRegistrySpec(tok string) bool {
	if tok == "" || tok == "." || tok == ".." {
		return false
	}
	if strings.HasPrefix(tok, "./") || strings.HasPrefix(tok, "../") || strings.HasPrefix(tok, "/") || strings.HasPrefix(tok, "~") {
		return false
	}
	if strings.HasPrefix(tok, "file:") || strings.HasPrefix(tok, "link:") || strings.HasPrefix(tok, "workspace:") {
		return false
	}
	if strings.Contains(tok, "://") || strings.HasPrefix(tok, "git+") || strings.HasPrefix(tok, "git@") {
		return false
	}
	return true
}

// toRef normalizes a package token into a pkgxray reference. Already-qualified
// references (npm:, github:) pass through; everything else is treated as an npm
// package name (optionally with an @version or scope).
func toRef(tok string) string {
	if strings.HasPrefix(tok, "npm:") || strings.HasPrefix(tok, "github:") {
		return tok
	}
	return "npm:" + tok
}

func isFlag(tok string) bool { return strings.HasPrefix(tok, "-") }

// flagValue parses --name=value forms; returns (value, true) on a match.
func flagValue(tok, name string) (string, bool) {
	prefix := name + "="
	if strings.HasPrefix(tok, prefix) {
		return strings.TrimPrefix(tok, prefix), true
	}
	return "", false
}

// tokenize splits a segment on whitespace while honoring single/double quotes
// so a quoted spec stays intact. Quotes are stripped from the result.
func tokenize(seg string) []string {
	var toks []string
	var cur strings.Builder
	var quote rune
	inTok := false
	flush := func() {
		if inTok {
			toks = append(toks, cur.String())
			cur.Reset()
			inTok = false
		}
	}
	for _, r := range seg {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
			inTok = true
		case r == '\'' || r == '"':
			quote = r
			inTok = true
		case r == ' ' || r == '\t':
			flush()
		default:
			cur.WriteRune(r)
			inTok = true
		}
	}
	flush()
	return toks
}

// indexToken returns the index of the first token exactly equal to want.
func indexToken(seg, want string) int {
	for i, t := range tokenize(seg) {
		if t == want {
			return i
		}
	}
	return -1
}

func dedupe(specs []InstallSpec) []InstallSpec {
	seen := make(map[string]bool, len(specs))
	var out []InstallSpec
	for _, s := range specs {
		if seen[s.Ref] {
			continue
		}
		seen[s.Ref] = true
		out = append(out, s)
	}
	return out
}
