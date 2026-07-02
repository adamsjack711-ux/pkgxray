// Command pkgxray-guard is a hookshot hook binary that audits packages with
// pkgxray before an AI coding agent installs them.
//
// It registers two unified hookshot handlers so it works across Claude Code,
// Cursor, Windsurf Cascade, Factory Droid, and OpenAI Codex:
//
//   - OnBeforeExecution: parses the agent's shell command for package installs
//     (npm/pnpm/yarn/bun add|install, npx/bunx/pnpm-dlx runners, and
//     `claude mcp add … -- <launcher>`), runs `pkgxray guard` on each package,
//     and denies the command on a BLOCK verdict — carrying pkgxray's cited
//     evidence back to the agent as the deny reason.
//   - OnAfterFileEdit: when the agent edits package.json or a lockfile, runs
//     `pkgxray audit` on it and feeds the verdict back as context (opt-in).
//
// Configuration (environment variables):
//
//	PKGXRAY_BIN             path to the pkgxray CLI (default "pkgxray")
//	PKGXRAY_HOOK_POLICY     strict | balanced | permissive (default "balanced")
//	PKGXRAY_HOOK_DISABLE    set to "1" to bypass all checks (fail-open)
//	PKGXRAY_HOOK_AUDIT_LOCKFILES  set to "1" to enable the OnAfterFileEdit audit
//	PKGXRAY_GUARD_ARGS      extra space-separated flags for `pkgxray guard`
//
// Build:   go build -o pkgxray-guard .
// Install: hookshot install --binary ./pkgxray-guard
package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/CorridorSecurity/hookshot"
	"github.com/CorridorSecurity/hookshot/examples/pkgxray-guard/pkgxrayguard"
)

func main() {
	cfg := loadConfig()

	hookshot.OnBeforeExecution(func(ctx hookshot.ExecutionContext) hookshot.ExecutionDecision {
		if cfg.disabled || ctx.Type != hookshot.ExecutionShell {
			return hookshot.AllowExecution()
		}
		specs := pkgxrayguard.ParseInstalls(ctx.Command)
		if len(specs) == 0 {
			return hookshot.AllowExecution()
		}
		return decideInstalls(cfg, specs)
	})

	hookshot.OnAfterFileEdit(func(ctx hookshot.FileEditContext) hookshot.FileEditDecision {
		if cfg.disabled || !cfg.auditLockfiles || !isDependencyManifest(ctx.FilePath) {
			return hookshot.FileEditOK()
		}
		return auditManifest(cfg, ctx.FilePath)
	})

	hookshot.RunCommand()
}

type config struct {
	guard          pkgxrayguard.Guard
	policy         pkgxrayguard.Policy
	disabled       bool
	auditLockfiles bool
}

func loadConfig() config {
	bin := os.Getenv("PKGXRAY_BIN")
	if bin == "" {
		bin = "pkgxray"
	}
	var extra []string
	if raw := strings.TrimSpace(os.Getenv("PKGXRAY_GUARD_ARGS")); raw != "" {
		extra = strings.Fields(raw)
	}
	return config{
		guard:          pkgxrayguard.Guard{Bin: bin, Timeout: 60 * time.Second, ExtraArgs: extra},
		policy:         pkgxrayguard.ParsePolicy(os.Getenv("PKGXRAY_HOOK_POLICY")),
		disabled:       os.Getenv("PKGXRAY_HOOK_DISABLE") == "1",
		auditLockfiles: os.Getenv("PKGXRAY_HOOK_AUDIT_LOCKFILES") == "1",
	}
}

// decideInstalls audits every package the command would install and folds the
// per-package results into one hook decision (worst verdict wins).
func decideInstalls(cfg config, specs []pkgxrayguard.InstallSpec) hookshot.ExecutionDecision {
	ctx := context.Background()
	results := make([]pkgxrayguard.Result, 0, len(specs))
	for _, spec := range specs {
		results = append(results, cfg.guard.Check(ctx, spec))
	}

	switch pkgxrayguard.DecideAll(cfg.policy, results) {
	case pkgxrayguard.Deny:
		return hookshot.DenyExecution(denyMessage(results))
	case pkgxrayguard.Ask:
		return hookshot.AskExecution(denyMessage(results))
	default:
		return hookshot.AllowExecutionWithReason("pkgxray: no blocking supply-chain risk in " + joinRefs(specs))
	}
}

// denyMessage renders the offending packages and pkgxray's cited evidence so
// the agent (and user) see why the install was stopped.
func denyMessage(results []pkgxrayguard.Result) string {
	var b strings.Builder
	b.WriteString("pkgxray blocked this install:")
	for _, r := range results {
		switch r.Verdict {
		case pkgxrayguard.Block, pkgxrayguard.Review, pkgxrayguard.Unknown:
			b.WriteString("\n  • ")
			b.WriteString(r.Spec.Ref)
			b.WriteString(" → ")
			b.WriteString(string(r.Verdict))
			if r.Summary != "" {
				b.WriteString(" (" + r.Summary + ")")
			}
			if r.Err != nil {
				b.WriteString(" [pkgxray error: " + r.Err.Error() + "]")
			}
			for _, reason := range r.Reasons {
				b.WriteString("\n      - ")
				b.WriteString(reason)
			}
		}
	}
	b.WriteString("\nRe-run `pkgxray guard <ref>` for the full report, or set PKGXRAY_HOOK_POLICY=permissive to override.")
	return b.String()
}

func joinRefs(specs []pkgxrayguard.InstallSpec) string {
	refs := make([]string, len(specs))
	for i, s := range specs {
		refs[i] = s.Ref
	}
	return strings.Join(refs, ", ")
}

// auditManifest runs `pkgxray audit <lockfile>` and reports the verdict back to
// the agent. Post-edit hooks can't undo the write, so a BLOCK becomes agent
// feedback (FileEditBlock, honored by Claude); anything else is added context.
func auditManifest(cfg config, filePath string) hookshot.FileEditDecision {
	bin := cfg.guard.Bin
	out, code := runCLI(bin, "audit", filePath)
	summary := firstLine(out)
	switch code {
	case 2:
		return hookshot.FileEditBlock("pkgxray flagged a dependency in " + filepath.Base(filePath) + ": " + summary)
	case 3:
		return hookshot.FileEditAddContext("pkgxray: review recommended for " + filepath.Base(filePath) + ": " + summary)
	default:
		return hookshot.FileEditOK()
	}
}
