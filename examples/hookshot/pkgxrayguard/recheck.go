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

// Rechecker runs `pkgxray recheck <lockfile> --format json` to re-evaluate a
// project's ALREADY-INSTALLED deps against current intelligence — out of band
// from the install-time gate, which only ever sees new installs. All drift
// logic lives in the engine; this is a thin orchestration layer that shells out
// and consumes the engine's JSON, reusing the same Verdict vocabulary and
// worst-fold as the install gate.
type Rechecker struct {
	Bin       string        // pkgxray executable (default "pkgxray")
	Timeout   time.Duration // whole-recheck timeout (default 300s — a tree fans out internally)
	ExtraArgs []string      // extra flags forwarded to `pkgxray recheck` (e.g. --no-github-diff)
	CacheURL  string        // PKGXRAY_CACHE_URL, shared with the install gate's warm cache
}

// recheckJSON is the subset of `pkgxray recheck … --format json` this hook
// consumes (the engine's recheckJson() shape, stable as of pkgxray >= 0.16.0):
//
//   - worstRegression: "safe" | "review" | "block" | null — the worst *new*
//     regression, NOT the worst absolute verdict. This is what the hook folds
//     on, so a dep that was block at install and is still block never surfaces.
//   - buckets.regressed[]: deps whose verdict got worse since checkedAt.
//   - versionDrift.updateAvailableFlagged[]: newer-but-flagged versions —
//     informational only, never part of the fold.
//   - exitCode: the engine's own 0/2/3 mapping (mirrored so a JSON-parse failure
//     still fails in the right direction).
type recheckJSON struct {
	WorstRegression *string `json:"worstRegression"`
	ExitCode        int     `json:"exitCode"`
	Buckets         struct {
		Regressed []struct {
			Name     string `json:"name"`
			Version  string `json:"version"`
			Baseline string `json:"baseline"`
			Verdict  string `json:"verdict"`
		} `json:"regressed"`
	} `json:"buckets"`
	VersionDrift struct {
		UpdateAvailableFlagged []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Worst   string `json:"worst"`
		} `json:"updateAvailableFlagged"`
	} `json:"versionDrift"`
}

// RegressedDep is one dependency whose stored verdict got worse.
type RegressedDep struct {
	Name     string
	Version  string
	Baseline string // verdict at install (checkedAt)
	Verdict  string // fresh verdict now
}

// FlaggedUpdate is a newer version that exists but guards review/block.
type FlaggedUpdate struct {
	Name    string
	Version string // currently pinned version
	Worst   string // worst verdict among the vetted newer candidates
}

// RecheckReport is the surfaced outcome of a project recheck.
type RecheckReport struct {
	Regressed      []RegressedDep  // actionable: a dep you already have went bad
	FlaggedUpdates []FlaggedUpdate // informational: don't blind-upgrade into these
	Worst          Verdict         // worst REGRESSION verdict (Safe when none); Unknown when the engine couldn't run
	Err            error           // set when the engine could not be run/parsed
}

// Recheck shells out to the engine and maps its JSON diff onto a RecheckReport.
// Version drift is deliberately excluded from Worst — mirroring the engine, an
// available flagged update you haven't installed is not an active exposure.
//
// A recheck that cannot reach or parse the engine yields Worst=Unknown with Err
// set, leaving the fail-open/closed choice to the policy layer — never a silent
// "nothing regressed".
func (rc Rechecker) Recheck(ctx context.Context, lockfilePath string) RecheckReport {
	bin := rc.Bin
	if bin == "" {
		bin = "pkgxray"
	}
	timeout := rc.Timeout
	if timeout == 0 {
		timeout = 300 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := append([]string{"recheck", lockfilePath, "--format", "json"}, rc.ExtraArgs...)
	cmd := exec.CommandContext(cctx, bin, args...)
	if rc.CacheURL != "" {
		cmd.Env = append(os.Environ(), "PKGXRAY_CACHE_URL="+rc.CacheURL)
	}
	stdout, runErr := cmd.Output()

	// A regression makes the engine exit non-zero (2/3) — that's an ExitError,
	// not a failure to run: the JSON is still on stdout. Only a missing binary,
	// timeout, etc. (no ExitError) means we hold no verdict at all.
	var exitErr *exec.ExitError
	if runErr != nil && !errors.As(runErr, &exitErr) {
		return RecheckReport{Worst: Unknown, Err: runErr}
	}

	var parsed recheckJSON
	if err := json.Unmarshal(stdout, &parsed); err != nil {
		return RecheckReport{Worst: Unknown, Err: errors.New("pkgxray recheck produced no parseable verdict")}
	}

	report := RecheckReport{Worst: worstRegressionVerdict(parsed.WorstRegression)}
	for _, r := range parsed.Buckets.Regressed {
		report.Regressed = append(report.Regressed, RegressedDep{
			Name:     r.Name,
			Version:  r.Version,
			Baseline: r.Baseline,
			Verdict:  r.Verdict,
		})
	}
	for _, f := range parsed.VersionDrift.UpdateAvailableFlagged {
		report.FlaggedUpdates = append(report.FlaggedUpdates, FlaggedUpdate{
			Name:    f.Name,
			Version: f.Version,
			Worst:   f.Worst,
		})
	}
	return report
}

// worstRegressionVerdict maps the engine's worstRegression field (null when
// nothing regressed) onto the hook's Verdict vocabulary.
func worstRegressionVerdict(worst *string) Verdict {
	if worst == nil {
		return Safe
	}
	switch strings.ToLower(strings.TrimSpace(*worst)) {
	case "block":
		return Block
	case "review":
		return Review
	default:
		return Safe
	}
}

// AsResults projects the regressions onto []Result so the shared DecideAll /
// worst-fold and policy layer decide the overall action — no second dialect.
// An engine failure (Worst=Unknown) contributes one Unknown result so a broken
// recheck folds toward Deny under fail-closed policies, never a false allow.
func (r RecheckReport) AsResults() []Result {
	if r.Err != nil || r.Worst == Unknown {
		return []Result{{Verdict: Unknown, Err: r.Err, Summary: "pkgxray recheck could not evaluate the project"}}
	}
	results := make([]Result, 0, len(r.Regressed))
	for _, d := range r.Regressed {
		results = append(results, Result{
			Spec:    InstallSpec{Ref: d.Name + "@" + d.Version},
			Verdict: verdictFromDecision(d.Verdict),
			Summary: "regressed since install: " + d.Baseline + " → " + d.Verdict,
		})
	}
	return results
}
