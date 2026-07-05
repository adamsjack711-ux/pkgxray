package pkgxrayguard

import (
	"path"
	"strings"
)

// Auto-wrap: rewrite `<cli> mcp add … <launcher>` so the registered stdio
// server runs behind `pkgxray mcp-proxy` — the per-call runtime gate (every
// tools/call checked, manifest re-audited on tools/list_changed, results
// screened for injection). The install gate sees a server exactly once, at
// registration; the proxy is how the protection follows the server into
// every session after that.
//
// Hookshot decisions cannot modify a command in place ({Allow, Reason, Ask}
// only), so the hook cannot substitute the wrapped command itself. Instead
// the main package DENIES the unwrapped registration with the rewritten
// command in the reason — the agent re-runs it, and the wrapped form (whose
// INNER launcher is still statically scanned via unwrapProxyTarget) passes.
// One extra round-trip, identical behavior on every harness hookshot speaks.

// mcpProxyValueFlags are `pkgxray mcp-proxy` flags that consume the next
// token — must be skipped when locating the real launcher inside a wrapped
// target.
var mcpProxyValueFlags = map[string]bool{
	"--policy": true,
	"--lock":   true,
}

// isProxyWrapped reports whether an add-target already launches through the
// runtime gate (`pkgxray mcp-proxy …` / `/path/to/pkgxray mcp-proxy …`).
func isProxyWrapped(target []string) bool {
	return len(target) >= 2 && path.Base(target[0]) == "pkgxray" && target[1] == "mcp-proxy"
}

// unwrapProxyTarget returns the real launcher command inside a wrapped
// target, so the static package scan applies to what will actually run.
func unwrapProxyTarget(target []string) ([]string, bool) {
	if !isProxyWrapped(target) {
		return nil, false
	}
	for i := 2; i < len(target); i++ {
		tok := target[i]
		if tok == "--" {
			if i+1 < len(target) {
				return target[i+1:], true
			}
			return nil, false
		}
		if isFlag(tok) {
			if mcpProxyValueFlags[tok] {
				i++
			}
			continue
		}
		return target[i:], true
	}
	return nil, false
}

// WrapMcpAdd rewrites a plain `<cli> mcp add [flags] <name> [--] <command…>`
// registration so the launcher runs behind `pkgxray mcp-proxy --policy <p>`.
// Returns ok=false when no rewrite applies: compound commands, non-add
// shapes, `add-json` (the launcher lives inside quoted JSON — rebuilding that
// through a tokenizer is how quoting bugs are born), http(s) URL targets (the
// proxy wraps stdio only), and targets that are already wrapped.
func WrapMcpAdd(command, policy string) (string, bool) {
	segments := splitSegments(command)
	if len(segments) != 1 {
		// `cd x && claude mcp add …` — rebuilding around shell operators is
		// not worth the risk; the registration is still gated, just unwrapped.
		return "", false
	}
	toks := tokenize(strings.TrimSpace(segments[0]))
	if len(toks) < 5 || toks[1] != "mcp" || toks[2] != "add" {
		return "", false
	}

	// Locate the target: mirror parseMcpAddArgs — skip flags (and value-flag
	// values); positional [0] is the server name, the target starts at [1] or
	// right after `--`.
	targetStart := -1
	hadDashDash := false
	positionals := 0
	for i := 3; i < len(toks); i++ {
		tok := toks[i]
		if tok == "--" {
			targetStart = i + 1
			hadDashDash = true
			break
		}
		if isFlag(tok) {
			if mcpAddValueFlags[tok] {
				i++
			}
			continue
		}
		positionals++
		if positionals == 2 {
			targetStart = i
			break
		}
	}
	if targetStart < 0 || targetStart >= len(toks) {
		return "", false
	}
	target := toks[targetStart:]

	lowered := strings.ToLower(target[0])
	if strings.HasPrefix(lowered, "http://") || strings.HasPrefix(lowered, "https://") {
		return "", false
	}
	if isProxyWrapped(target) {
		return "", false
	}

	if policy == "" {
		policy = "balanced"
	}
	rebuilt := append([]string{}, toks[:targetStart]...)
	if !hadDashDash {
		// Without `--` the host CLI would claim the proxy's flags as its own.
		rebuilt = append(rebuilt, "--")
	}
	rebuilt = append(rebuilt, "pkgxray", "mcp-proxy", "--policy", policy, "--")
	rebuilt = append(rebuilt, target...)

	quoted := make([]string, len(rebuilt))
	for i, tok := range rebuilt {
		quoted[i] = shellQuote(tok)
	}
	return strings.Join(quoted, " "), true
}

// shellQuote makes a rebuilt token safe to paste back into a shell command:
// tokenize() stripped the original quotes, so anything with whitespace or
// shell metacharacters is re-quoted.
func shellQuote(tok string) string {
	if tok == "" {
		return "''"
	}
	if !strings.ContainsAny(tok, " \t\n'\"\\$&|;<>()`*?[]#~{}") {
		return tok
	}
	return "'" + strings.ReplaceAll(tok, "'", `'\''`) + "'"
}
