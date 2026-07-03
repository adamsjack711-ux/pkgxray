package pkgxrayguard

import (
	"context"
	"testing"
)

// fakeRecheck writes a shell script that mimics `pkgxray recheck … --format
// json` — prints the given JSON and exits with the given code. Reuses the same
// tmp-script mechanism as fakePkgxray (guard_test.go).
func fakeRecheck(t *testing.T, jsonOut string, exitCode int) string {
	return fakePkgxray(t, jsonOut, exitCode)
}

// A regressed dep must surface as a Block verdict that folds to Deny (a
// notify/ask-level signal), NOT silence.
func TestRecheckRegressedSurfaces(t *testing.T) {
	out := `{"worstRegression":"block","exitCode":2,"buckets":{"regressed":[` +
		`{"name":"gonebad","version":"2.0.0","baseline":"safe","verdict":"block"}` +
		`]},"versionDrift":{"updateAvailableFlagged":[]}}`
	rc := Rechecker{Bin: fakeRecheck(t, out, 2)}
	report := rc.Recheck(context.Background(), "package-lock.json")

	if report.Err != nil {
		t.Fatalf("unexpected err: %v", report.Err)
	}
	if len(report.Regressed) != 1 || report.Regressed[0].Name != "gonebad" {
		t.Fatalf("expected one regressed dep 'gonebad', got %+v", report.Regressed)
	}
	if report.Worst != Block {
		t.Fatalf("worst = %s, want block", report.Worst)
	}
	// Folds to Deny under any policy (block is denied everywhere).
	if got := DecideAll(Balanced, report.AsResults()); got != Deny {
		t.Fatalf("DecideAll = %s, want deny", got)
	}
}

// A regression only to review folds to Ask under balanced (notify), not Deny.
func TestRecheckReviewRegressionAsks(t *testing.T) {
	out := `{"worstRegression":"review","exitCode":3,"buckets":{"regressed":[` +
		`{"name":"soft","version":"1.0.0","baseline":"safe","verdict":"review"}` +
		`]},"versionDrift":{"updateAvailableFlagged":[]}}`
	rc := Rechecker{Bin: fakeRecheck(t, out, 3)}
	report := rc.Recheck(context.Background(), "package-lock.json")
	if report.Worst != Review {
		t.Fatalf("worst = %s, want review", report.Worst)
	}
	if got := DecideAll(Balanced, report.AsResults()); got != Ask {
		t.Fatalf("DecideAll = %s, want ask", got)
	}
}

// A clean recheck (worstRegression=null) is silent: no regressions, folds to Allow.
func TestRecheckCleanIsSilent(t *testing.T) {
	out := `{"worstRegression":null,"exitCode":0,"buckets":{"regressed":[]},` +
		`"versionDrift":{"updateAvailableFlagged":[]}}`
	rc := Rechecker{Bin: fakeRecheck(t, out, 0)}
	report := rc.Recheck(context.Background(), "package-lock.json")
	if len(report.Regressed) != 0 {
		t.Fatalf("expected no regressions, got %+v", report.Regressed)
	}
	if report.Worst != Safe {
		t.Fatalf("worst = %s, want safe", report.Worst)
	}
	if got := DecideAll(Balanced, report.AsResults()); got != Allow {
		t.Fatalf("DecideAll = %s, want allow", got)
	}
}

// Engine unreachable → Unknown, never a false allow. Under fail-closed policies
// it folds to Deny; under permissive it is allowed through.
func TestRecheckEngineUnreachableIsUnknown(t *testing.T) {
	rc := Rechecker{Bin: "/nonexistent/pkgxray-xyz"}
	report := rc.Recheck(context.Background(), "package-lock.json")
	if report.Worst != Unknown || report.Err == nil {
		t.Fatalf("expected Unknown+err, got worst=%s err=%v", report.Worst, report.Err)
	}
	if got := DecideAll(Balanced, report.AsResults()); got != Deny {
		t.Fatalf("balanced DecideAll = %s, want deny (fail-closed)", got)
	}
	if got := DecideAll(Permissive, report.AsResults()); got != Allow {
		t.Fatalf("permissive DecideAll = %s, want allow", got)
	}
}

// Unparseable engine output is treated as Unknown, not a false clean result.
func TestRecheckUnparseableIsUnknown(t *testing.T) {
	rc := Rechecker{Bin: fakeRecheck(t, "not json at all", 0)}
	report := rc.Recheck(context.Background(), "package-lock.json")
	if report.Worst != Unknown || report.Err == nil {
		t.Fatalf("expected Unknown+err on unparseable output, got worst=%s err=%v", report.Worst, report.Err)
	}
}

// The fold keys off the worst REGRESSION, not the worst absolute verdict: a
// still-block dep at install is not in the regressed bucket, so a review-only
// regression yields Review (Ask), never Block (Deny).
func TestRecheckFoldsWorstRegressionNotAbsolute(t *testing.T) {
	// The engine already excluded the pre-existing block from `regressed`; the
	// hook must trust worstRegression + the bucket, not re-fold everything.
	out := `{"worstRegression":"review","exitCode":3,"buckets":{"regressed":[` +
		`{"name":"slipped","version":"1.0.0","baseline":"safe","verdict":"review"}` +
		`]},"versionDrift":{"updateAvailableFlagged":[]}}`
	rc := Rechecker{Bin: fakeRecheck(t, out, 3)}
	report := rc.Recheck(context.Background(), "package-lock.json")
	if report.Worst != Review {
		t.Fatalf("worst = %s, want review (not block)", report.Worst)
	}
	if got := DecideAll(Strict, report.AsResults()); got != Deny {
		// strict denies review too — but that's review→deny, still not a block-driven deny
		t.Logf("strict review→deny (expected): %s", got)
	}
}

// Version-drift flagged updates are informational: they populate FlaggedUpdates
// but never enter the fold, so a clean-but-update-available project stays Allow.
func TestRecheckVersionDriftIsInformational(t *testing.T) {
	out := `{"worstRegression":null,"exitCode":0,"buckets":{"regressed":[]},` +
		`"versionDrift":{"updateAvailableFlagged":[{"name":"widget","version":"1.0.0","worst":"block"}]}}`
	rc := Rechecker{Bin: fakeRecheck(t, out, 0)}
	report := rc.Recheck(context.Background(), "package-lock.json")
	if len(report.FlaggedUpdates) != 1 || report.FlaggedUpdates[0].Name != "widget" {
		t.Fatalf("expected one flagged update, got %+v", report.FlaggedUpdates)
	}
	if report.Worst != Safe {
		t.Fatalf("worst = %s, want safe (version drift does not fold)", report.Worst)
	}
	if got := DecideAll(Balanced, report.AsResults()); got != Allow {
		t.Fatalf("DecideAll = %s, want allow — flagged updates must not block", got)
	}
}
