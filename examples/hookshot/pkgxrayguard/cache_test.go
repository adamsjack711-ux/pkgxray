package pkgxrayguard

import (
	"context"
	"testing"
)

// fakeChecker records how many times Check ran per ref and returns a scripted
// verdict.
type fakeChecker struct {
	calls   map[string]int
	verdict Verdict
	err     error
}

func (f *fakeChecker) Check(_ context.Context, spec InstallSpec) Result {
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[spec.Ref]++
	return Result{Spec: spec, Verdict: f.verdict, Err: f.err}
}

func TestMemoGuardCachesSameRef(t *testing.T) {
	f := &fakeChecker{verdict: Safe}
	m := NewMemoGuard(f)
	spec := InstallSpec{Ref: "npm:express@4.18.0"}

	m.Check(context.Background(), spec)
	m.Check(context.Background(), spec)

	if f.calls[spec.Ref] != 1 {
		t.Fatalf("underlying Check ran %d times, want 1 (second call should hit cache)", f.calls[spec.Ref])
	}
}

func TestMemoGuardDoesNotCacheAcrossVersions(t *testing.T) {
	f := &fakeChecker{verdict: Safe}
	m := NewMemoGuard(f)

	m.Check(context.Background(), InstallSpec{Ref: "npm:express@4.18.0"})
	m.Check(context.Background(), InstallSpec{Ref: "npm:express@5.0.0"})

	if f.calls["npm:express@4.18.0"] != 1 || f.calls["npm:express@5.0.0"] != 1 {
		t.Fatalf("each version should be scanned once, got %v", f.calls)
	}
}

func TestMemoGuardDoesNotCacheUnknown(t *testing.T) {
	f := &fakeChecker{verdict: Unknown}
	m := NewMemoGuard(f)
	spec := InstallSpec{Ref: "npm:flaky"}

	m.Check(context.Background(), spec)
	m.Check(context.Background(), spec)

	if f.calls[spec.Ref] != 2 {
		t.Fatalf("Unknown verdict must not be cached; Check ran %d times, want 2", f.calls[spec.Ref])
	}
}

func TestMemoGuardDoesNotCacheErrors(t *testing.T) {
	f := &fakeChecker{verdict: Review, err: context.DeadlineExceeded}
	m := NewMemoGuard(f)
	spec := InstallSpec{Ref: "npm:slow"}

	m.Check(context.Background(), spec)
	m.Check(context.Background(), spec)

	if f.calls[spec.Ref] != 2 {
		t.Fatalf("errored result must not be cached; Check ran %d times, want 2", f.calls[spec.Ref])
	}
}
