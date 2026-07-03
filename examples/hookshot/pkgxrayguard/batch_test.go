package pkgxrayguard

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

// checkerFunc adapts a function to the Checker interface for tests.
type checkerFunc func(context.Context, InstallSpec) Result

func (f checkerFunc) Check(ctx context.Context, s InstallSpec) Result { return f(ctx, s) }

func TestCheckAllRunsEverySpecInOrder(t *testing.T) {
	fake := checkerFunc(func(_ context.Context, s InstallSpec) Result {
		return Result{Spec: s, Verdict: Safe}
	})
	specs := make([]InstallSpec, 12)
	for i := range specs {
		specs[i] = InstallSpec{Ref: fmt.Sprintf("npm:p%d", i)}
	}
	res := CheckAll(context.Background(), fake, specs, 4)
	if len(res) != len(specs) {
		t.Fatalf("got %d results, want %d", len(res), len(specs))
	}
	for i, r := range res {
		if r.Spec.Ref != specs[i].Ref {
			t.Errorf("result[%d].Ref = %q, want %q (order not preserved)", i, r.Spec.Ref, specs[i].Ref)
		}
	}
}

func TestCheckAllBoundsConcurrency(t *testing.T) {
	var inflight, maxSeen int32
	fake := checkerFunc(func(_ context.Context, s InstallSpec) Result {
		n := atomic.AddInt32(&inflight, 1)
		for { // record the high-water mark
			m := atomic.LoadInt32(&maxSeen)
			if n <= m || atomic.CompareAndSwapInt32(&maxSeen, m, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond) // hold the slot so overlap is observable
		atomic.AddInt32(&inflight, -1)
		return Result{Spec: s, Verdict: Safe}
	})
	specs := make([]InstallSpec, 20)
	for i := range specs {
		specs[i] = InstallSpec{Ref: fmt.Sprintf("npm:p%d", i)}
	}
	workers := 4
	CheckAll(context.Background(), fake, specs, workers)

	if maxSeen > int32(workers) {
		t.Errorf("observed %d concurrent checks, exceeds cap %d", maxSeen, workers)
	}
	if maxSeen < 2 {
		t.Errorf("expected real parallelism, max concurrency was %d", maxSeen)
	}
}

func TestCheckAllEdgeCases(t *testing.T) {
	fake := checkerFunc(func(_ context.Context, s InstallSpec) Result {
		return Result{Spec: s, Verdict: Safe}
	})
	if got := CheckAll(context.Background(), fake, nil, 4); len(got) != 0 {
		t.Errorf("empty specs → %d results, want 0", len(got))
	}
	// workers < 1 must not deadlock or panic — treated as sequential.
	one := []InstallSpec{{Ref: "npm:solo"}}
	if got := CheckAll(context.Background(), fake, one, 0); len(got) != 1 || got[0].Spec.Ref != "npm:solo" {
		t.Errorf("workers=0 → %v, want one result for npm:solo", got)
	}
}
