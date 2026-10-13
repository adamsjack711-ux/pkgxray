package pkgxrayguard

import (
	"context"
	"testing"
)

func TestExecutionVerdictFailsClosedOnMissingAndContradictoryApprovals(t *testing.T) {
	cases := []struct {
		output string
		exit   int
		want   Verdict
	}{
		{`not json`, 0, Unknown}, {`{}`, 0, Unknown},
		{`{"decision":"unknown"}`, 0, Unknown}, {`{"decision":"future-verdict"}`, 0, Unknown},
		{`{"decision":"allow"}`, 2, Block}, {`{"decision":"allow"}`, 3, Review},
		{`{"decision":"allow"}`, 1, Unknown}, {`{"decision":"block"}`, 0, Block},
	}
	for _, tc := range cases {
		g := Guard{Bin: fakePkgxray(t, tc.output, tc.exit)}
		result := g.Check(context.Background(), InstallSpec{Ref: "npm:inert-fixture"})
		if result.Verdict != tc.want {
			t.Errorf("output=%s exit=%d: got %s, want %s", tc.output, tc.exit, result.Verdict, tc.want)
		}
		if tc.want == Unknown && result.Err == nil {
			t.Error("unknown result requires error evidence")
		}
	}
}

func TestMcpMissingVerdictIsNotExitZeroApproval(t *testing.T) {
	for _, output := range []string{`not json`, `{}`, `{"verdict":"unknown"}`} {
		g := Guard{Bin: fakePkgxray(t, output, 0)}
		result := g.Check(context.Background(), InstallSpec{Ref: "https://inert.example/mcp", Kind: KindMcpHTTP})
		if result.Verdict != Unknown || result.Err == nil {
			t.Fatalf("output=%s: got %+v, want unknown", output, result)
		}
	}
}

func TestInvalidVerdictNeverAllowsUnderAnyPolicy(t *testing.T) {
	for _, policy := range []Policy{Strict, Balanced, Permissive} {
		for _, verdict := range []Verdict{"", "typo", "ALLOW", "new-verdict"} {
			if got := Decide(policy, verdict); got != Deny {
				t.Fatalf("%s %q: got %s, want deny", policy, verdict, got)
			}
		}
	}
}

func TestMandatoryCoverageHoldsDenyEvenUnderPermissive(t *testing.T) {
	for _, category := range []string{"incomplete-source-scan", "incomplete-dependency-scan", "unsupported-behavior", "flow-analysis-gap", "unresolved-runtime-execution", "unverified-provenance"} {
		output := `{"decision":"review","report":{"findings":[{"category":"` + category + `"}]}}`
		result := (Guard{Bin: fakePkgxray(t, output, 3)}).Check(context.Background(), InstallSpec{Ref: "npm:inert-fixture"})
		if !result.MandatoryHold {
			t.Fatalf("%s was not held", category)
		}
		for _, policy := range []Policy{Strict, Balanced, Permissive} {
			if DecideResult(policy, result) != Deny {
				t.Fatalf("%s allowed %s hold", policy, category)
			}
		}
	}
}

func TestInvalidProvenanceReceiptCannotAllow(t *testing.T) {
	output := `{"decision":"allow","approval":{"sourceComplete":true,"checks":{"source":"completed","vulnerabilities":"completed","provenance":"invalid"},"authorization":{"mandatoryHoldReasons":[],"behavioralCoverage":"completed","explicitOverride":false}}}`
	result := (Guard{Bin: fakePkgxray(t, output, 0)}).Check(context.Background(), InstallSpec{Ref: "npm:inert-fixture"})
	for _, policy := range []Policy{Strict, Balanced, Permissive} {
		if DecideResult(policy, result) != Deny {
			t.Fatalf("%s accepted invalid provenance approval", policy)
		}
	}
}

func TestBoundedPolicyFoldProperty(t *testing.T) {
	// Exhaust all pairs: adding a block or hold must never reduce enforcement.
	for _, policy := range []Policy{Strict, Balanced, Permissive} {
		for _, first := range []Verdict{Safe, Review, Block, Unknown, "invalid"} {
			for _, second := range []Verdict{Safe, Review, Block, Unknown, "invalid"} {
				results := []Result{{Verdict: first}, {Verdict: second}, {Verdict: Block}}
				if DecideAll(policy, results) != Deny {
					t.Fatal("block lost in policy fold")
				}
				results[2] = Result{Verdict: Safe, MandatoryHold: true}
				if DecideAll(policy, results) != Deny {
					t.Fatal("mandatory hold lost in policy fold")
				}
			}
		}
	}
}

func TestRecheckCannotInventCleanResultFromMissingVerdictOrEmptyBuckets(t *testing.T) {
	for _, output := range []string{`{}`, `{"worstRegression":"unrecognized"}`} {
		report := (Rechecker{Bin: fakeRecheck(t, output, 0)}).Recheck(context.Background(), "package-lock.json")
		if report.Worst != Unknown || DecideAll(Balanced, report.AsResults()) != Deny {
			t.Fatalf("missing verdict allowed: %+v", report)
		}
	}
	report := (Rechecker{Bin: fakeRecheck(t, `{"worstRegression":"block","buckets":{"regressed":[]}}`, 2)}).Recheck(context.Background(), "package-lock.json")
	if DecideAll(Balanced, report.AsResults()) != Deny {
		t.Fatal("empty bucket erased block summary")
	}
}
