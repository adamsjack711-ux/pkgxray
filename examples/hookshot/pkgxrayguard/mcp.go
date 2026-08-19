package pkgxrayguard

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// MCP-server registration gating.
//
// `<cli> mcp add` writes a server into the agent's config; from then on the
// host launches it (stdio) or connects to it (HTTP) with no further gate. So
// add-time is the moment to look:
//
//   - stdio launcher (`… mcp add x -- npx some-server`, or the same without
//     `--`): the launcher parses to a registry spec and takes the existing
//     STATIC package scan — the hook never spawns the server itself
//     (package-scan-first; connect-time enumeration is a follow-up step the
//     deny/ask message points at).
//   - streamable-HTTP URL: `pkgxray mcp <url>` performs a read-only
//     handshake + tools/list and audits the manifest (injection, concealment,
//     capability mismatch). Connecting to the URL is a network fetch the
//     agent itself was about to do — not local code execution.
//   - legacy SSE transport: the probe cannot speak it — unvettable, Review.

// mcpAddValueFlags are `mcp add` flags that consume the next token. Keeping
// this list right matters: a missed value flag would make its value look like
// the name/target positional.
var mcpAddValueFlags = map[string]bool{
	"--transport": true, "-t": true,
	"--scope": true, "-s": true,
	"--header": true, "-H": true,
	"--env": true, "-e": true,
}

// parseMcpAdd recognizes `<anything> mcp add <name> <url|command…>` and
// `<anything> mcp add-json <name> <json>`. Returns nil when the segment is
// not an mcp add at all (so parseSegment falls through to the other shapes).
func parseMcpAdd(toks []string) []InstallSpec {
	if len(toks) < 3 || toks[1] != "mcp" {
		return nil
	}
	switch toks[2] {
	case "add":
		return parseMcpAddArgs(toks[3:])
	case "add-json":
		return parseMcpAddJSON(toks[3:])
	}
	return nil
}

func parseMcpAddArgs(args []string) []InstallSpec {
	transport := ""
	var positionals []string
	for i := 0; i < len(args); i++ {
		tok := args[i]
		if tok == "--" {
			// Everything after `--` is the launcher command.
			positionals = append(positionals, args[i+1:]...)
			break
		}
		if isFlag(tok) {
			if v, ok := flagValue(tok, "--transport"); ok {
				transport = v
				continue
			}
			if mcpAddValueFlags[tok] {
				if tok == "--transport" || tok == "-t" {
					if i+1 < len(args) {
						transport = args[i+1]
					}
				}
				i++ // skip the flag's value
			}
			continue
		}
		positionals = append(positionals, tok)
	}
	// positionals[0] is the server name; the target starts at [1].
	if len(positionals) < 2 {
		return nil
	}
	return mcpTargetSpecs(positionals[1:], transport)
}

// parseMcpAddJSON handles `mcp add-json <name> '<json>'` where the JSON is a
// server config: {"type":"http","url":…} or {"command":…,"args":[…]}.
func parseMcpAddJSON(args []string) []InstallSpec {
	var raw string
	var positionals int
	for _, tok := range args {
		if isFlag(tok) {
			continue
		}
		positionals++
		if positionals == 2 { // [0]=name, [1]=json
			raw = tok
			break
		}
	}
	if raw == "" {
		return nil
	}
	var cfg struct {
		Type    string   `json:"type"`
		URL     string   `json:"url"`
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		// Unparseable server JSON: the add will register SOMETHING we could
		// not inspect — surface it rather than silently allowing.
		return []InstallSpec{{Ref: "mcp-config", Manager: "mcp", Raw: clip(raw, 60), Kind: KindMcpSSE}}
	}
	if cfg.URL != "" {
		return mcpTargetSpecs([]string{cfg.URL}, cfg.Type)
	}
	if cfg.Command != "" {
		return parseSegment(strings.Join(append([]string{cfg.Command}, cfg.Args...), " "))
	}
	return nil
}

// mcpTargetSpecs classifies the add target: an http(s) URL becomes an MCP
// probe spec (or an unvettable SSE spec), anything else is a launcher command
// that re-enters the normal parser and takes the static package-scan path.
func mcpTargetSpecs(target []string, transport string) []InstallSpec {
	// A target already wrapped in the runtime gate (`pkgxray mcp-proxy … --
	// npx x`): scan the INNER launcher — that is what will actually run.
	if inner, ok := unwrapProxyTarget(target); ok {
		return mcpTargetSpecs(inner, transport)
	}
	first := target[0]
	if strings.HasPrefix(first, "http://") || strings.HasPrefix(first, "https://") {
		kind := KindMcpHTTP
		if strings.EqualFold(transport, "sse") {
			kind = KindMcpSSE
		}
		return []InstallSpec{{Ref: first, Manager: "mcp", Raw: first, Kind: kind}}
	}
	return parseSegment(strings.Join(target, " "))
}

// ---------------------------------------------------------------------------
// Probe — `pkgxray mcp <url> --format json`
// ---------------------------------------------------------------------------

// mcpJSON is the subset of `pkgxray mcp <url> --format json` output the hook
// consumes (stable as of pkgxray >= 0.16.0): top-level `verdict`
// (safe|review|block, exit 2/3/0 as fallback), `manifest.server` and
// `manifest.tools` for the summary, `manifestAudit.findings[]` for evidence.
type mcpJSON struct {
	Verdict  string `json:"verdict"`
	Manifest struct {
		Server struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"server"`
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	} `json:"manifest"`
	ManifestAudit struct {
		Findings []struct {
			Severity  string `json:"severity"`
			Category  string `json:"category"`
			Rationale string `json:"rationale"`
			File      string `json:"file"`
		} `json:"findings"`
	} `json:"manifestAudit"`
}

// checkMcp audits one MCP spec. SSE (and any config we could not read) is
// Review by construction; HTTP is probed with `pkgxray mcp`. Engine failure
// yields Unknown, which the policy layer fails closed (deny under
// strict/balanced) — same rule as everywhere else in the hook.
func (g Guard) checkMcp(ctx context.Context, spec InstallSpec) Result {
	if spec.Kind == KindMcpSSE {
		return Result{
			Spec:    spec,
			Verdict: Review,
			Summary: "MCP server config the hook cannot probe (legacy SSE transport or unreadable JSON) — review the server manually before trusting its tools",
		}
	}
	if g.DisableMcpProbe {
		return Result{
			Spec:    spec,
			Verdict: Review,
			Summary: "MCP manifest probe disabled (PKGXRAY_HOOK_MCP_PROBE=0) — server registered unvetted",
		}
	}

	bin := ResolveBin(g.Bin)
	timeout := g.Timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, bin, "mcp", spec.Ref, "--format", "json")
	// The child needs the standard install prefixes on PATH: pkgxray is a
	// node script, so both it and its interpreter have to be findable even
	// when the hook itself was launched with a minimal environment.
	cmd.Env = ChildEnv()
	if g.CacheURL != "" {
		cmd.Env = append(cmd.Env, "PKGXRAY_CACHE_URL="+g.CacheURL)
	}
	stdout, runErr := cmd.Output()

	exitCode := 0
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		exitCode = exitErr.ExitCode()
	} else if runErr != nil {
		return Result{Spec: spec, Verdict: Unknown, Err: runErr}
	}

	res := Result{Spec: spec}
	var parsed mcpJSON
	if err := json.Unmarshal(stdout, &parsed); err == nil {
		res.Verdict = verdictFromDecision(parsed.Verdict)
		res.Summary = mcpSummary(parsed)
		res.Reasons = mcpReasons(parsed)
	}
	if res.Verdict == "" || res.Verdict == Unknown {
		res.Verdict = verdictFromExit(exitCode)
	}
	if res.Verdict == Unknown && res.Err == nil {
		res.Err = errors.New("pkgxray mcp produced no verdict")
	}
	return res
}

func mcpSummary(p mcpJSON) string {
	name := p.Manifest.Server.Name
	if name == "" {
		name = "(unnamed server)"
	}
	return "MCP manifest audit: " + name + "@" + p.Manifest.Server.Version +
		", " + strconv.Itoa(len(p.Manifest.Tools)) + " tools"
}

func mcpReasons(p mcpJSON) []string {
	var reasons []string
	for _, f := range p.ManifestAudit.Findings {
		sev := strings.ToLower(f.Severity)
		if sev != "high" && sev != "medium" {
			continue
		}
		reason := f.Rationale
		if reason == "" {
			reason = f.Category
		}
		line := "[" + f.Category + "] " + clip(reason, 160)
		if f.File != "" {
			line += " (" + clip(f.File, 80) + ")"
		}
		reasons = append(reasons, line)
		if len(reasons) == 3 {
			break
		}
	}
	return reasons
}
