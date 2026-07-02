package pkgxrayguard

import (
	"context"
	"sync"
)

// Checker is the pkgxray-triage capability MemoGuard wraps. Guard satisfies it;
// tests inject a fake.
type Checker interface {
	Check(ctx context.Context, spec InstallSpec) Result
}

// MemoGuard memoizes verdicts for the lifetime of the hook process (one agent
// session). Re-installing the same package is common within a session and each
// underlying guard call is ~1.3–1.5s cold (mostly network), so caching keeps
// the agent's critical path fast — the main reason a user would otherwise
// disable the hook.
//
// Two correctness rules:
//   - The key is spec.Ref, which already carries the @version, so a different
//     version is a different key and never reuses another version's verdict.
//   - An Unknown / errored result is never cached, so a transient pkgxray
//     failure doesn't pin a wrong answer for the rest of the session.
type MemoGuard struct {
	inner Checker
	mu    sync.Mutex
	cache map[string]Result
}

// NewMemoGuard wraps a Checker with a session cache.
func NewMemoGuard(inner Checker) *MemoGuard {
	return &MemoGuard{inner: inner, cache: make(map[string]Result)}
}

// Check returns a cached verdict for spec.Ref when one exists, otherwise runs
// the wrapped Checker and caches a real verdict.
func (m *MemoGuard) Check(ctx context.Context, spec InstallSpec) Result {
	m.mu.Lock()
	if r, ok := m.cache[spec.Ref]; ok {
		m.mu.Unlock()
		return r
	}
	m.mu.Unlock()

	r := m.inner.Check(ctx, spec)

	if r.Verdict == Unknown || r.Err != nil {
		return r // never memoize a non-verdict / transient failure
	}
	m.mu.Lock()
	m.cache[spec.Ref] = r
	m.mu.Unlock()
	return r
}
