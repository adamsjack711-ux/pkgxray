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

// SpecKind distinguishes a registry package (pkgxray can triage it) from an
// unvettable remote spec (an arbitrary git/tarball/HTTP URL, which pre-install
// registry triage cannot resolve).
type SpecKind string

const (
	KindRegistry SpecKind = "registry"
	KindVCS      SpecKind = "vcs" // git+/git@/tarball/HTTP URL — unvettable, review-worthy
	// An MCP server the agent is registering. KindMcpHTTP carries a streamable-
	// HTTP URL that `pkgxray mcp <url>` can probe (network connect + read-only
	// manifest enumeration — no local code execution). KindMcpSSE is the legacy
	// SSE transport the probe cannot speak — unvettable, review-worthy, like
	// KindVCS. Stdio servers never get their own kind: their launcher command
	// (npx/bunx/…) already parses to a registry spec and takes the static
	// package-scan path — the package-scan-first order from the MCP adapter.
	KindMcpHTTP SpecKind = "mcp-http"
	KindMcpSSE  SpecKind = "mcp-sse"
)

// InstallSpec is a single package an agent is about to install/run, expressed
// as a pkgxray reference.
type InstallSpec struct {
	Ref       string   // pkgxray reference, e.g. "npm:express@4.18.0" (or the raw URL for a VCS spec)
	Manager   string   // "npm" | "pnpm" | "yarn" | "bun" | "npx"
	Raw       string   // the original token, for messages
	Kind      SpecKind // registry | vcs
	Immediate bool     // true for npx/bunx/pnpm-dlx/bun x — runs package code without a persistent install
}

// ParseInstalls extracts the packages a shell command would fetch from a
// registry, across npm/pnpm/yarn/bun installs, npx/bunx/pnpm-dlx runners, and
// `claude mcp add … -- <launcher>` forms. It is deliberately conservative:
// unrecognized shapes yield nothing rather than a wrong reference, and local
// paths / VCS URLs are skipped because pre-install registry triage does not
// apply to them.
func ParseInstalls(command string) []InstallSpec {
	var out []InstallSpec
	for _, seg := range splitSegments(stripHeredocs(command)) {
		out = append(out, parseSegment(seg)...)
	}
	return dedupe(out)
}

// stripHeredocs removes here-document bodies from a command line. A body is
// data the command reads on stdin, not a command the shell runs, so parsing it
// yields packages that were never going to be fetched: writing a README, a CI
// config, or a test fixture that merely quotes an install command is enough to
// trip the gate on whatever the quoted text happens to contain.
//
// The scan is deliberately literal — find the redirection, take the delimiter
// word after it, drop lines until that word stands alone. An unterminated body
// is dropped to the end of the input, which is what the shell does with one too.
func stripHeredocs(command string) string {
	lines := strings.Split(command, "\n")
	var out []string
	for i := 0; i < len(lines); i++ {
		out = append(out, lines[i])
		delim, ok := heredocDelimiter(lines[i])
		if !ok {
			continue
		}
		for i+1 < len(lines) && strings.TrimSpace(lines[i+1]) != delim {
			i++
		}
		i++ // consume the closing delimiter line as well
	}
	return strings.Join(out, "\n")
}

// heredocDelimiter returns the delimiter word of the last here-document opened
// on a line. The quoted form (<<'EOF') and the leading-tab form (<<-EOF) are
// both accepted; a <<< here-string is a single-line construct with no body, and
// << followed by no word at all is not a heredoc.
func heredocDelimiter(line string) (string, bool) {
	delim, found := "", false
	for i := 0; i+1 < len(line); i++ {
		if line[i] != '<' || line[i+1] != '<' {
			continue
		}
		// Skip the interior of a longer run of <, so the last two characters of
		// a <<< here-string are not mistaken for a heredoc open.
		if i > 0 && line[i-1] == '<' {
			continue
		}
		rest := line[i+2:]
		if strings.HasPrefix(rest, "<") { // <<< here-string
			continue
		}
		rest = strings.TrimPrefix(rest, "-")
		rest = strings.TrimLeft(rest, " \t")
		if rest == "" {
			continue
		}
		var word string
		if q := rest[0]; q == '\'' || q == '"' {
			end := strings.IndexByte(rest[1:], q)
			if end < 0 {
				continue
			}
			word = rest[1 : 1+end]
		} else {
			fields := strings.FieldsFunc(rest, func(r rune) bool {
				return r == ' ' || r == '\t' || r == '|' || r == ';' || r == '&' || r == '>' || r == '<'
			})
			if len(fields) == 0 {
				continue
			}
			word = fields[0]
		}
		if word != "" {
			delim, found = word, true
		}
	}
	return delim, found
}

// splitSegments breaks a command line into independently-executed pieces on
// newlines and the shell operators && || ; | and a lone & (backgrounding).
//
// The & cases need care, because & also appears inside redirections: `&>file`
// redirects both streams and `2>&1` duplicates a descriptor. Splitting on those
// would tear a redirection in half and leave its tail looking like an argument.
func splitSegments(command string) []string {
	var segs []string
	var cur strings.Builder
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			segs = append(segs, s)
		}
		cur.Reset()
	}
	rs := []rune(command)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == '\n' || r == ';':
			flush()
		case r == '|':
			if i+1 < len(rs) && rs[i+1] == '|' {
				i++
			}
			flush()
		case r == '&':
			switch {
			case i+1 < len(rs) && rs[i+1] == '&': // && — a separator
				i++
				flush()
			case i+1 < len(rs) && rs[i+1] == '>': // &>file — a redirection
				cur.WriteRune(r)
			case lastNonSpace(cur.String()) == '>': // 2>&1 — an fd duplication
				cur.WriteRune(r)
			default: // a lone & backgrounds the command before it
				flush()
			}
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return segs
}

// lastNonSpace returns the final non-whitespace rune of s, or 0 if there is none.
func lastNonSpace(s string) rune {
	for i := len(s) - 1; i >= 0; i-- {
		if r := rune(s[i]); r != ' ' && r != '\t' {
			return r
		}
	}
	return 0
}

func parseSegment(seg string) []InstallSpec {
	// Redirections are shell plumbing, not arguments — drop them once, up front,
	// so every path below (MCP add, the `--` recursion, the installers) sees the
	// same clean token list and their indices agree.
	toks := stripRedirections(tokenize(seg))

	// `<cli> mcp add …` (claude today; the shape is CLI-agnostic on purpose):
	// registering an MCP server. Handled before the generic `--` recursion so
	// URL forms without a `--` are seen too.
	if specs := parseMcpAdd(toks); specs != nil {
		return specs
	}

	// `claude mcp add <name> -- <launcher…>` (and similar wrappers): the real
	// package lives in the launcher command after the `--` separator.
	if i := indexOf(toks, "--"); i >= 0 {
		rhs := strings.Join(toks[i+1:], " ")
		if rhs != "" {
			if specs := parseSegment(rhs); len(specs) > 0 {
				return specs
			}
		}
	}

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

// valueFlags take their value as a SEPARATE token, so the token after them is a
// config value and not a package. Without this, `--tag latest` reports "latest"
// as a dependency and `-w api <pkg>` reports the workspace name.
//
// The list is deliberate rather than a blanket "skip whatever follows a flag":
// skipping the token after every flag would hide the package in `-g <pkg>`. A
// value-taking flag missing from this list keeps the old behavior, so add new
// ones as the package managers grow them. Entries cover npm, pnpm, yarn and bun.
var valueFlags = map[string]bool{
	"--prefix": true, "-C": true, "--dir": true, "--cwd": true,
	"--registry": true, "--cache": true, "--store-dir": true,
	"--userconfig": true, "--globalconfig": true, "--config": true,
	"--loglevel": true, "--tag": true, "--backend": true,
	"--omit": true, "--include": true, "--filter": true,
	"--workspace": true, "-w": true, "--workspace-root": false,
	"--before": true, "--script-shell": true, "--shell": true,
	"--install-strategy": true, "--save-prefix": true,
	"--node-options": true, "--auth-type": true, "--node-linker": true,
	"--access": true, "--otp": true, "--depth": true,
	"--user-agent": true, "--fetch-timeout": true,
	"--fetch-retries": true, "--maxsockets": true,
	"--call": true, "-c": true, "--cpu": true, "--os": true,
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
	rest := args[1:]
	for i := 0; i < len(rest); i++ {
		tok := rest[i]
		if isFlag(tok) {
			if valueFlags[tok] {
				i++ // the next token is this flag's value, not a package
			}
			continue
		}
		kind, ok := classifySpec(tok)
		if !ok {
			continue
		}
		specs = append(specs, InstallSpec{Ref: toRef(tok, kind), Manager: manager, Raw: tok, Kind: kind})
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
			if valueFlags[tok] {
				i++ // skip this flag's value; the package comes after it
			}
			continue
		}
		// First bare token is the package npx resolves and runs.
		return runnerSpec(tok)
	}
	return nil
}

func runnerSpec(tok string) []InstallSpec {
	kind, ok := classifySpec(tok)
	if !ok {
		return nil
	}
	// npx/bunx/pnpm-dlx execute the fetched package immediately.
	return []InstallSpec{{Ref: toRef(tok, kind), Manager: "npx", Raw: tok, Kind: kind, Immediate: true}}
}

// classifySpec buckets an install token. Local paths and workspace/link specs
// point at already-visible code (nothing to gate) and are skipped. Git/tarball/
// HTTP URLs can't be resolved by pre-install registry triage, so they surface
// as an unvettable KindVCS spec (review-worthy) rather than being silently
// allowed. Everything else is a registry package.
func classifySpec(tok string) (SpecKind, bool) {
	if tok == "" || tok == "." || tok == ".." {
		return "", false
	}
	if strings.HasPrefix(tok, "./") || strings.HasPrefix(tok, "../") || strings.HasPrefix(tok, "/") || strings.HasPrefix(tok, "~") {
		return "", false
	}
	if strings.HasPrefix(tok, "file:") || strings.HasPrefix(tok, "link:") || strings.HasPrefix(tok, "workspace:") {
		return "", false
	}
	if strings.Contains(tok, "://") || strings.HasPrefix(tok, "git+") || strings.HasPrefix(tok, "git@") {
		return KindVCS, true
	}
	return KindRegistry, true
}

// toRef normalizes a package token into a pkgxray reference. A VCS/URL spec is
// carried verbatim (there is no registry ref to build). Already-qualified
// references (npm:, github:) pass through; everything else is treated as an npm
// package name (optionally with an @version or scope).
func toRef(tok string, kind SpecKind) string {
	if kind == KindVCS {
		return tok
	}
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

// redirectMarker stands in for a shell redirection operator (> >> < << 2> &>
// >&) in the token stream. A NUL byte cannot appear in a real command-line
// argument, so the marker can never collide with one.
const redirectMarker = "\x00redirect"

// tokenize splits a segment on whitespace while honoring single/double quotes
// so a quoted spec stays intact. Quotes are stripped from the result.
//
// Redirection operators become redirectMarker tokens rather than ordinary
// words, whether or not whitespace separates them from their target. Without
// this, a command ending in `> out.txt` yields two extra "packages" — ">" and
// "out.txt" — and the second is a plausible enough name that the resulting
// denial reads as a genuine finding rather than a parser artifact.
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
	rs := []rune(seg)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
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
		case r == '>' || r == '<':
			// A bare descriptor number belongs to the operator, not to the word
			// before it: `2>` redirects fd 2, it does not name a package "2".
			if inTok && isAllDigits(cur.String()) {
				cur.Reset()
				inTok = false
			}
			flush()
			// Consume the rest of the operator: >> << >& <&.
			if i+1 < len(rs) && (rs[i+1] == r || rs[i+1] == '&') {
				i++
			}
			toks = append(toks, redirectMarker)
		case r == '&':
			// Only `&>` (and `&>>`) is a redirection here; a lone & has already
			// been consumed as a separator by splitSegments.
			flush()
			if i+1 < len(rs) && rs[i+1] == '>' {
				i++
				if i+1 < len(rs) && rs[i+1] == '>' {
					i++
				}
				toks = append(toks, redirectMarker)
			}
		default:
			cur.WriteRune(r)
			inTok = true
		}
	}
	flush()
	return toks
}

// stripRedirections drops every redirection operator and the target that
// follows it, leaving only the words that are really arguments to the command.
func stripRedirections(toks []string) []string {
	var out []string
	for i := 0; i < len(toks); i++ {
		if toks[i] == redirectMarker {
			i++ // also skip the redirect target, when one is present
			continue
		}
		out = append(out, toks[i])
	}
	return out
}

// isAllDigits reports whether s is one or more ASCII digits and nothing else.
func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// indexOf returns the index of the first token exactly equal to want.
func indexOf(toks []string, want string) int {
	for i, t := range toks {
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
