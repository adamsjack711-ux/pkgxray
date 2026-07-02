package pkgxrayguard

import (
	"context"
	"encoding/json"
	"errors"
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
	Spec    InstallSpec
	Verdict Verdict
	Summary string   // pkgxray's one-line verdict summary
	Reasons []string // top high/medium findings, "[category] rationale"
	Err     error    // set when pkgxray could not be run or parsed
}

// Guard runs the pkgxray CLI to triage packages.
type Guard struct {
	Bin       string        // pkgxray executable (default "pkgxray")
	Timeout   time.Duration // per-package timeout (default 60s)
	ExtraArgs []string      // extra guard flags, e.g. ["--no-github-diff"]
}

// pkgxray guard --format json output (subset we consume).
type guardJSON struct {
	Decision string `json:"decision"` // allow | review | block
	Report   struct {
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
// the verdict from the JSON decision, falling back to the process exit code
// (2=block, 3=review, 0=safe) so a truncated/unparsable payload still fails in
// the correct direction. Any execution error yields Verdict=Unknown with Err
// set, leaving the fail-open/closed choice to the policy layer.
func (g Guard) Check(ctx context.Context, spec InstallSpec) Result {
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

	bin := g.Bin
	if bin == "" {
		bin = "pkgxray"
	}
	timeout := g.Timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := append([]string{"guard", spec.Ref, "--format", "json"}, g.ExtraArgs...)
	cmd := exec.CommandContext(cctx, bin, args...)
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
	}
	if res.Verdict == "" || res.Verdict == Unknown {
		res.Verdict = verdictFromExit(exitCode)
	}
	if res.Verdict == Unknown && res.Err == nil {
		res.Err = errors.New("pkgxray produced no verdict")
	}
	return res
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
