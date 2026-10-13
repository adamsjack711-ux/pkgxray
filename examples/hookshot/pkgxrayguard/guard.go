package pkgxrayguard

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Verdict is pkgxray's decision for a single package.
type Verdict string

const (
	Safe    Verdict = "safe"    // pkgxray decision "allow"/"safe", exit 0
	Review  Verdict = "review"  // exit 3 — a human should look
	Block   Verdict = "block"   // exit 2 — high-severity supply-chain risk
	Unknown Verdict = "unknown" // pkgxray could not run / produced no verdict
)

// Result is the outcome of auditing one InstallSpec.
type Result struct {
	Spec          InstallSpec
	Verdict       Verdict
	Summary       string   // pkgxray's one-line verdict summary
	Reasons       []string // top high/medium findings, "[category] rationale"
	Err           error    // set when pkgxray could not be run or parsed
	MandatoryHold bool     // behavioral/provenance coverage did not authorize installation
}

// Guard runs the pkgxray CLI to triage packages.
type Guard struct {
	Bin             string        // pkgxray executable (default "pkgxray")
	Timeout         time.Duration // per-package timeout (default 60s)
	ExtraArgs       []string      // extra guard flags, e.g. ["--no-github-diff"]
	CacheURL        string        // PKGXRAY_CACHE_URL forwarded to the CLI so registry/GitHub fetches collapse across runs (optional)
	DisableMcpProbe bool          // skip the `pkgxray mcp <url>` probe; MCP-HTTP adds surface as Review instead
}

// guardJSON is the subset of `pkgxray guard <ref> --format json` output this
// hook consumes — the CLI contract it depends on:
//
//   - top-level `decision`: "allow" | "review" | "block"
//   - process exit code 2=block, 3=review (denial-only fallback when JSON
//     can't be parsed; exit 0 alone cannot establish an approval)
//   - `report.summary` and `report.findings[].{severity,category,rationale,file}`
//     (`file` drives the location shown in a deny/ask message)
//
// This shape remains available in pkgxray 1.x. The hook degrades safely against
// drift: a missing `file` just omits the path, and if `decision` is absent it
// retains denial exit codes — so an older or erroring pkgxray fails toward
// UNKNOWN (denied under strict/balanced), never a false allow. The hook does not
// invoke pkgxray's `--version` command at runtime; the operator verifies the
// pinned CLI during installation. See the README "Requirements" section.
type guardJSON struct {
	Decision string `json:"decision"` // allow | review | block
	Approval *struct {
		SourceComplete bool `json:"sourceComplete"`
		Checks         struct {
			Source          string `json:"source"`
			Vulnerabilities string `json:"vulnerabilities"`
			Provenance      string `json:"provenance"`
		} `json:"checks"`
		Authorization struct {
			MandatoryHoldReasons []string `json:"mandatoryHoldReasons"`
			BehavioralCoverage   string   `json:"behavioralCoverage"`
			ExplicitOverride     bool     `json:"explicitOverride"`
		} `json:"authorization"`
	} `json:"approval"`
	Report struct {
		Summary  string `json:"summary"`
		Findings []struct {
			Severity  string `json:"severity"`
			Category  string `json:"category"`
			Rationale string `json:"rationale"`
			File      string `json:"file"`
		} `json:"findings"`
	} `json:"report"`
}

// Check audits one package with `pkgxray guard <ref> --format json`. It derives
// the verdict from the JSON decision, retaining denial process exit codes
// (2=block, 3=review) so a truncated/unparsable payload still fails in
// the correct direction. Any execution error yields Verdict=Unknown with Err
// set, leaving the fail-open/closed choice to the policy layer.
func (g Guard) Check(ctx context.Context, spec InstallSpec) Result {
	// MCP server registrations take the manifest-probe path (see mcp.go).
	if spec.Kind == KindMcpHTTP || spec.Kind == KindMcpSSE {
		return g.checkMcp(ctx, spec)
	}

	// A git/tarball/HTTP URL can't be resolved by pre-install registry triage —
	// pkgxray has no registry ref to fetch. Surface it as review-worthy rather
	// than shelling out (which would just error) or silently allowing it.
	if spec.Kind == KindVCS {
		return Result{
			Spec:    spec,
			Verdict: Review,
			Summary: "unvettable git/URL install spec — pkgxray cannot triage an arbitrary VCS or remote tarball; review the source manually",
		}
	}

	bin := ResolveBin(g.Bin)
	timeout := g.Timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := append([]string{"guard", spec.Ref, "--format", "json"}, g.ExtraArgs...)
	cmd := exec.CommandContext(cctx, bin, args...)
	// pkgxray reads PKGXRAY_CACHE_URL from its environment (github.js routes
	// upstream fetches through the cache server). A child inherits our env, but
	// forward it explicitly so it still reaches the CLI if the host ever
	// sanitizes the hook's child environment.
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
		// Binary missing, timeout, etc. — no verdict at all.
		return Result{Spec: spec, Verdict: Unknown, Err: runErr}
	}

	res := Result{Spec: spec}
	var parsed guardJSON
	if err := json.Unmarshal(stdout, &parsed); err == nil {
		res.Verdict = verdictFromDecision(parsed.Decision)
		res.Summary = strings.TrimSpace(parsed.Report.Summary)
		res.Reasons = topReasons(parsed)
		res.MandatoryHold = mandatoryHold(parsed)
	}
	res.Verdict = executionVerdict(res.Verdict, exitCode)
	if res.Verdict == Unknown && res.Err == nil {
		res.Err = errors.New("pkgxray produced no verdict")
	}
	return res
}

// An exit code can preserve a denial after broken JSON, but exit 0 alone is
// not an approval. Contradictory output is never downgraded to SAFE.
func executionVerdict(v Verdict, code int) Verdict {
	if v == Block || code == 2 {
		return Block
	}
	if code != 0 && code != 3 {
		return Unknown
	}
	if v == Review || code == 3 {
		return Review
	}
	if v == Safe && code == 0 {
		return Safe
	}
	return Unknown
}

func mandatoryHold(p guardJSON) bool {
	hold := false
	for _, finding := range p.Report.Findings {
		switch finding.Category {
		case "incomplete-source-scan", "incomplete-dependency-scan", "unsupported-behavior", "flow-analysis-gap", "unresolved-runtime-execution", "unverified-provenance":
			hold = true
		}
	}
	if p.Approval == nil {
		return hold || os.Getenv("PKGXRAY_REQUIRE_PROVENANCE") == "1"
	}
	a := p.Approval
	if a.Checks.Provenance == "invalid" {
		return true
	}
	if os.Getenv("PKGXRAY_REQUIRE_PROVENANCE") == "1" && a.Checks.Provenance != "verified" {
		return true
	}
	if !a.SourceComplete || a.Checks.Source != "completed" || a.Checks.Vulnerabilities != "completed" {
		return true
	}
	hold = hold || len(a.Authorization.MandatoryHoldReasons) != 0 || a.Authorization.BehavioralCoverage != "completed"
	if hold && a.Authorization.ExplicitOverride && verdictFromDecision(p.Decision) == Safe {
		return false
	}
	return hold
}

func verdictFromDecision(decision string) Verdict {
	switch strings.ToLower(strings.TrimSpace(decision)) {
	case "block":
		return Block
	case "review":
		return Review
	case "allow", "safe":
		return Safe
	default:
		return Unknown
	}
}

func verdictFromExit(code int) Verdict {
	switch code {
	case 0:
		return Safe
	case 2:
		return Block
	case 3:
		return Review
	default:
		return Unknown
	}
}

func topReasons(p guardJSON) []string {
	var reasons []string
	for _, f := range p.Report.Findings {
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

func clip(s string, n int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

// severity ranks verdicts so the worst one across a multi-package command wins.
func severity(v Verdict) int {
	switch v {
	case Block:
		return 3
	case Unknown:
		return 2
	case Review:
		return 1
	default: // Safe
		return 0
	}
}

// Worst returns the highest-severity verdict among results.
func Worst(results []Result) Verdict {
	worst := Safe
	for _, r := range results {
		if severity(r.Verdict) > severity(worst) {
			worst = r.Verdict
		}
	}
	return worst
}
