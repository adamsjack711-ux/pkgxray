package pkgxrayguard

import (
	"context"
	"sync"
)

// DefaultGuardWorkers bounds how many packages in a single command are guarded
// at once. Guarding is independent per package but each Check spawns a pkgxray
// process that hits the network, so this caps concurrent load rather than
// firing one process per package unbounded.
const DefaultGuardWorkers = 8

// CheckAll runs checker.Check on every spec with bounded concurrency and returns
// the results in the same order as specs. Because packages are guarded
// independently, this turns a multi-package command's latency from the sum of
// the per-package times into roughly max(per-package) × ceil(n/workers) — the
// difference between ~10s and ~1s for a 20-package install.
//
// checker must be safe for concurrent use (Guard is stateless; MemoGuard guards
// its cache with a mutex). workers < 1 is treated as 1.
func CheckAll(ctx context.Context, checker Checker, specs []InstallSpec, workers int) []Result {
	results := make([]Result, len(specs))
	if len(specs) == 0 {
		return results
	}
	if workers < 1 {
		workers = 1
	}
	if workers > len(specs) {
		workers = len(specs)
	}

	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for i := range specs {
		wg.Add(1)
		sem <- struct{}{} // block once `workers` are in flight
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = checker.Check(ctx, specs[i]) // own index → no shared-slice race
		}(i)
	}
	wg.Wait()
	return results
}
