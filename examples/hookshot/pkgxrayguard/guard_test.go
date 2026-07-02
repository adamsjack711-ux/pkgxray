package pkgxrayguard

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDecide(t *testing.T) {
	cases := []struct {
		policy Policy
		v      Verdict
		want   Action
	}{
		{Strict, Block, Deny},
		{Strict, Review, Deny},
		{Strict, Unknown, Deny},
		{Strict, Safe, Allow},
		{Balanced, Block, Deny},
		{Balanced, Review, Ask},
		{Balanced, Unknown, Deny},
		{Balanced, Safe, Allow},
		{Permissive, Block, Deny},
		{Permissive, Review, Allow},
		{Permissive, Unknown, Allow},
		{Permissive, Safe, Allow},
	}
	for _, tc := range cases {
		if got := Decide(tc.policy, tc.v); got != tc.want {
			t.Errorf("Decide(%s, %s) = %s, want %s", tc.policy, tc.v, got, tc.want)
		}
	}
}

func TestParsePolicyDefault(t *testing.T) {
	if ParsePolicy("nonsense") != Balanced {
		t.Fatal("unknown policy should default to Balanced")
	}
	if ParsePolicy("STRICT") != Strict {
		t.Fatal("policy parse should be case-insensitive")
	}
}

func TestWorst(t *testing.T) {
	results := []Result{{Verdict: Safe}, {Verdict: Review}, {Verdict: Block}, {Verdict: Safe}}
	if got := Worst(results); got != Block {
		t.Fatalf("Worst = %s, want block", got)
	}
	if got := Worst([]Result{{Verdict: Safe}, {Verdict: Review}}); got != Review {
		t.Fatalf("Worst = %s, want review", got)
	}
}

// fakePkgxray writes a shell script that mimics `pkgxray guard … --format json`:
// it prints the given JSON to stdout and exits with the given code.
func fakePkgxray(t *testing.T, jsonOut string, exitCode int) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake shell script not supported on windows")
	}
	dir := t.TempDir()
	p := filepath.Join(dir, "pkgxray")
	script := "#!/bin/sh\ncat <<'EOF'\n" + jsonOut + "\nEOF\nexit " + itoa(exitCode) + "\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

func TestCheckBlock(t *testing.T) {
	out := `{"decision":"block","report":{"summary":"1 high-severity finding","findings":[` +
		`{"severity":"high","category":"credential-access","rationale":"reads ~/.aws/credentials near a network sink"},` +
		`{"severity":"info","category":"noise","rationale":"ignore me"}]}}`
	g := Guard{Bin: fakePkgxray(t, out, 2)}
	res := g.Check(context.Background(), InstallSpec{Ref: "npm:evil"})
	if res.Verdict != Block {
		t.Fatalf("verdict = %s, want block", res.Verdict)
	}
	if len(res.Reasons) != 1 || res.Reasons[0] != "[credential-access] reads ~/.aws/credentials near a network sink" {
		t.Fatalf("reasons = %v", res.Reasons)
	}
	if res.Summary != "1 high-severity finding" {
		t.Fatalf("summary = %q", res.Summary)
	}
}

func TestCheckSafe(t *testing.T) {
	g := Guard{Bin: fakePkgxray(t, `{"decision":"allow","report":{"summary":"no risk","findings":[]}}`, 0)}
	res := g.Check(context.Background(), InstallSpec{Ref: "npm:lodash"})
	if res.Verdict != Safe {
		t.Fatalf("verdict = %s, want safe", res.Verdict)
	}
}

func TestCheckExitCodeFallback(t *testing.T) {
	// Unparseable stdout but exit code 3 → review via exit-code fallback.
	g := Guard{Bin: fakePkgxray(t, "not json", 3)}
	res := g.Check(context.Background(), InstallSpec{Ref: "npm:x"})
	if res.Verdict != Review {
		t.Fatalf("verdict = %s, want review", res.Verdict)
	}
}

func TestCheckMissingBinary(t *testing.T) {
	g := Guard{Bin: "/nonexistent/pkgxray-binary-xyz"}
	res := g.Check(context.Background(), InstallSpec{Ref: "npm:x"})
	if res.Verdict != Unknown || res.Err == nil {
		t.Fatalf("verdict = %s err = %v, want unknown + error", res.Verdict, res.Err)
	}
}
