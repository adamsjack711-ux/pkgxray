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
//     evidence back to the agent as the deny reason. MCP server registrations
//     (`… mcp add`) are gated too: a stdio launcher takes the static package
//     scan (the hook never spawns the server), a streamable-HTTP URL is probed
//     with `pkgxray mcp <url>` (read-only manifest enumeration + audit), and a
//     legacy SSE config surfaces as review-worthy. A vetted stdio registration
//     is then AUTO-WRAPPED: the unwrapped `mcp add` is denied with the same
//     command rewritten to launch through `pkgxray mcp-proxy` (the per-call
//     runtime gate) in the deny reason — the agent re-runs the wrapped form,
//     whose inner launcher is still scanned, and it passes (default on;
//     PKGXRAY_HOOK_MCP_WRAP=0 to disable).
//   - OnAfterFileEdit: when the agent edits an MCP config file (.mcp.json,
//     mcp.json, mcp_config.json, claude_desktop_config.json), gates the
//     added/changed server entries exactly like an `mcp add` command — closing
//     the write-the-config-directly bypass (on by default). Once the gate
//     clears, the vetted stdio entries are auto-wrapped IN PLACE to launch
//     through `pkgxray mcp-proxy`: unlike a command, a config file is shared
//     state the hook can rewrite, so no agent round-trip is needed
//     (PKGXRAY_HOOK_MCP_WRAP=0 to disable). When the agent edits package.json
//     or a lockfile, runs `pkgxray audit` on it and feeds the verdict back as
//     context (opt-in).
//
// Out-of-band subcommands (invoked directly, not via a hook event):
//
//	pkgxray-guard recheck [lockfile]   re-evaluate installed deps vs. fresh intel
//	pkgxray-guard wrap-config <file>…  wrap every unwrapped stdio server in an
//	                                   existing MCP config behind `pkgxray mcp-proxy`
//
// Configuration (environment variables):
//
//	PKGXRAY_BIN             path to the pkgxray CLI (default "pkgxray")
//	PKGXRAY_HOOK_POLICY     strict | balanced | permissive (default "balanced")
//	PKGXRAY_HOOK_DISABLE    set to "1" to bypass all checks (fail-open)
//	PKGXRAY_HOOK_AUDIT_LOCKFILES  set to "1" to enable the OnAfterFileEdit audit
//	PKGXRAY_GUARD_ARGS      extra space-separated flags for `pkgxray guard`
//	PKGXRAY_HOOK_MCP_PROBE  set to "0" to skip probing HTTP MCP servers on
//	                        `mcp add` (they then surface as REVIEW, not probed)
//	PKGXRAY_HOOK_MCP_WRAP   set to "0" to stop auto-wrapping vetted stdio
//	                        servers (both `mcp add` launchers and config entries)
//	                        behind `pkgxray mcp-proxy`
//
// Build:   go build -o pkgxray-guard .
// Install: hookshot install --binary ./pkgxray-guard
package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/CorridorSecurity/hookshot"
	"github.com/CorridorSecurity/hookshot/examples/pkgxray-guard/pkgxrayguard"
)

func main() {
	// Out-of-band `recheck` subcommand. Hookshot only dispatches event hooks
	// (OnBeforeExecution / OnAfterFileEdit) via RunCommand — there is no periodic
	// entry point — so re-evaluating already-installed deps against fresh
	// intelligence is exposed as a plain subcommand a cron/CI step (or a human)
	// invokes: `pkgxray-guard recheck [lockfile]`. See README "Out-of-band recheck".
	if len(os.Args) > 1 && os.Args[1] == "recheck" {
		os.Exit(runRecheck(loadConfig(), os.Args[2:]))
	}
	// Out-of-band `wrap-config` subcommand: retrofit the runtime gate onto MCP
	// config files already on disk (servers registered before this hook was
	// installed). Same rewrite as the OnAfterFileEdit auto-wrap, applied to
	// every unwrapped stdio entry rather than just the newly-added ones.
	if len(os.Args) > 1 && os.Args[1] == "wrap-config" {
		os.Exit(runWrapConfig(loadConfig(), os.Args[2:]))
	}

	cfg := loadConfig()

	hookshot.OnBeforeExecution(func(ctx hookshot.ExecutionContext) hookshot.ExecutionDecision {
		if cfg.disabled || ctx.Type != hookshot.ExecutionShell {
			return hookshot.AllowExecution()
		}
		specs := pkgxrayguard.ParseInstalls(ctx.Command)
		if len(specs) > 0 {
			decision := decideInstalls(cfg, specs)
			if !decision.Allow {
				// A flagged launcher stays denied/asked as-is — never mix the
				// verdict message with wrap instructions.
				return decision
			}
			if wrapped, ok := wrapCandidate(cfg, ctx.Command); ok {
				return hookshot.DenyExecution(wrapMessage(wrapped))
			}
			return decision
		}
		// No parseable package specs, but the command may still register a
		// stdio MCP server pkgxray cannot statically vet (a local binary, a
		// python launcher, …) — the runtime gate is MOST valuable exactly
		// there, so the wrap rewrite applies to those registrations too.
		if wrapped, ok := wrapCandidate(cfg, ctx.Command); ok {
			return hookshot.DenyExecution(wrapMessage(wrapped))
		}
		return hookshot.AllowExecution()
	})

	hookshot.OnAfterFileEdit(func(ctx hookshot.FileEditContext) hookshot.FileEditDecision {
		if cfg.disabled {
			return hookshot.FileEditOK()
		}
		// MCP config files (.mcp.json & friends): writing one registers a
		// server without any `mcp add` command for the execution gate to see.
		// This closes that bypass, so it is ON by default (only the global
		// PKGXRAY_HOOK_DISABLE turns it off) — unlike the opt-in lockfile audit.
		if pkgxrayguard.IsMcpConfig(ctx.FilePath) {
			return decideMcpConfigEdit(cfg, ctx.FilePath, toFileEdits(ctx.Edits))
		}
		if !cfg.auditLockfiles || !isDependencyManifest(ctx.FilePath) {
			return hookshot.FileEditOK()
		}
		return auditManifestEdit(cfg, ctx.FilePath, toFileEdits(ctx.Edits))
	})

	hookshot.RunCommand()
}

type config struct {
	guard          pkgxrayguard.Guard   // raw guard (used for lockfile audits)
	checker        pkgxrayguard.Checker // session-memoized wrapper for install checks
	policy         pkgxrayguard.Policy
	disabled       bool
	auditLockfiles bool
	mcpWrap        bool // auto-rewrite `mcp add` launchers behind `pkgxray mcp-proxy`
	guardWorkers   int  // max packages guarded concurrently per command
}

// wrapCandidate applies the auto-wrap rewrite when it is enabled and the
// command is an unwrapped stdio `mcp add`. The policy the proxy enforces at
// runtime mirrors the hook's own.
func wrapCandidate(cfg config, command string) (string, bool) {
	if !cfg.mcpWrap {
		return "", false
	}
	return pkgxrayguard.WrapMcpAdd(command, string(cfg.policy))
}

// wrapMessage is the deny reason that delegates the rewrite to the agent:
// hookshot decisions cannot modify a command in place, so the wrapped command
// travels back as instructions. One extra round-trip, every harness.
func wrapMessage(wrapped string) string {
	return "pkgxray: this MCP server registration is allowed, but stdio servers should run behind " +
		"pkgxray's per-call runtime gate (audits every tools/call, re-checks the manifest on " +
		"tools/list_changed, screens tool results for injection). Re-run the registration with the " +
		"launcher wrapped:\n\n  " + wrapped + "\n\n" +
		"The wrapped form will be allowed (its inner launcher is still statically scanned). " +
		"Requires pkgxray >= 0.17 on PATH at server launch time. " +
		"Set PKGXRAY_HOOK_MCP_WRAP=0 to register servers unwrapped."
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
	guard := pkgxrayguard.Guard{
		Bin:             bin,
		Timeout:         60 * time.Second,
		ExtraArgs:       extra,
		CacheURL:        strings.TrimSpace(os.Getenv("PKGXRAY_CACHE_URL")),
		DisableMcpProbe: os.Getenv("PKGXRAY_HOOK_MCP_PROBE") == "0",
	}
	workers := pkgxrayguard.DefaultGuardWorkers
	if v := strings.TrimSpace(os.Getenv("PKGXRAY_HOOK_CONCURRENCY")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 {
			workers = n
		}
	}
	return config{
		guard: guard,
		// One memo per process = one agent session; repeat installs of the same
		// ref@version reuse the first verdict instead of re-scanning.
		checker:        pkgxrayguard.NewMemoGuard(guard),
		policy:         pkgxrayguard.ParsePolicy(os.Getenv("PKGXRAY_HOOK_POLICY")),
		disabled:       os.Getenv("PKGXRAY_HOOK_DISABLE") == "1",
		auditLockfiles: os.Getenv("PKGXRAY_HOOK_AUDIT_LOCKFILES") == "1",
		mcpWrap:        os.Getenv("PKGXRAY_HOOK_MCP_WRAP") != "0",
		guardWorkers:   workers,
	}
}

// decideInstalls audits every package the command would install and folds the
// per-package results into one hook decision (worst verdict wins).
func decideInstalls(cfg config, specs []pkgxrayguard.InstallSpec) hookshot.ExecutionDecision {
	ctx := context.Background()
	results := pkgxrayguard.CheckAll(ctx, cfg.checker, specs, cfg.guardWorkers)

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

// runRecheck implements the out-of-band `recheck` subcommand: locate the
// project lockfile, re-evaluate its already-installed deps against current
// intelligence, and surface any regressions. It reuses the same policy folding
// (DecideAll) and Verdict vocabulary as the install gate — a regressed dep is
// treated exactly like a flagged install would be.
//
// Exit codes mirror the gate/CLI: 0 = nothing regressed, 3 = a dep regressed to
// review (ask/notify), 2 = a dep regressed to block, or the engine was
// unreachable under a fail-closed policy. Version drift is informational and
// never moves the exit code. The bounded-concurrency fan-out lives in the
// engine's single `recheck` call — the hook does not re-implement it.
func runRecheck(cfg config, args []string) int {
	lockfile, err := resolveLockfile(args)
	if err != nil {
		os.Stderr.WriteString("pkgxray-guard recheck: " + err.Error() + "\n")
		return 2
	}

	rc := pkgxrayguard.Rechecker{
		Bin:       cfg.guard.Bin,
		Timeout:   5 * time.Minute,
		ExtraArgs: cfg.guard.ExtraArgs,
		CacheURL:  cfg.guard.CacheURL,
	}
	report := rc.Recheck(context.Background(), lockfile)

	// Fold the regressions (plus an Unknown, if the engine failed) through the
	// shared policy layer — no second dialect for allow/ask/deny.
	action := pkgxrayguard.DecideAll(cfg.policy, report.AsResults())
	os.Stdout.WriteString(renderRecheck(lockfile, report, action))

	switch action {
	case pkgxrayguard.Deny:
		return 2
	case pkgxrayguard.Ask:
		return 3
	default:
		return 0
	}
}

// runWrapConfig implements `pkgxray-guard wrap-config <file>…`: it rewrites
// every unwrapped stdio server in each named MCP config file to launch through
// `pkgxray mcp-proxy` — the same rewrite the OnAfterFileEdit hook applies to
// newly-added entries, applied instead to entries already on disk. Returns 2 if
// any file could not be wrapped (missing, or not strict JSON), 0 otherwise.
func runWrapConfig(cfg config, args []string) int {
	var files []string
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			files = append(files, a)
		}
	}
	if len(files) == 0 {
		os.Stderr.WriteString("pkgxray-guard wrap-config: no config file given\n" +
			"usage: pkgxray-guard wrap-config <.mcp.json | mcp.json | mcp_config.json | …>\n")
		return 2
	}
	failed := false
	for _, f := range files {
		wrapped, err := pkgxrayguard.WrapMcpConfigFile(f, nil, string(cfg.policy))
		switch {
		case err != nil:
			os.Stderr.WriteString("pkgxray-guard wrap-config: " + f + ": " + err.Error() + "\n")
			failed = true
		case len(wrapped) == 0:
			os.Stdout.WriteString(f + ": no unwrapped stdio servers\n")
		default:
			os.Stdout.WriteString(f + ": wrapped " + joinNames(wrapped) +
				" behind `pkgxray mcp-proxy --policy " + string(cfg.policy) + "`\n")
		}
	}
	if failed {
		return 2
	}
	return 0
}

// resolveLockfile takes an explicit path argument or auto-detects the project
// lockfile in the current directory, preferring the most precise (a real
// lockfile) over package.json.
func resolveLockfile(args []string) (string, error) {
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			if _, err := os.Stat(a); err != nil {
				return "", errors.New("lockfile not found: " + a)
			}
			return a, nil
		}
	}
	for _, name := range []string{"package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "package.json"} {
		if _, err := os.Stat(name); err == nil {
			return name, nil
		}
	}
	return "", errors.New("no lockfile found in the current directory (package-lock.json | yarn.lock | pnpm-lock.yaml | package.json); pass one explicitly")
}

// renderRecheck produces the surfaced report. Regressed deps are the actionable
// ask/notify signal; version-drift flagged updates are informational only.
func renderRecheck(lockfile string, report pkgxrayguard.RecheckReport, action pkgxrayguard.Action) string {
	var b strings.Builder
	if report.Err != nil {
		b.WriteString("pkgxray recheck could not evaluate " + lockfile + ": " + report.Err.Error() + "\n")
		if action == pkgxrayguard.Allow {
			b.WriteString("(permissive policy: treated as non-blocking)\n")
		}
		return b.String()
	}

	if len(report.Regressed) == 0 && len(report.FlaggedUpdates) == 0 {
		return "pkgxray recheck: no regressions in " + lockfile + " — nothing you already depend on became worse.\n"
	}

	if len(report.Regressed) > 0 {
		b.WriteString("pkgxray recheck: a dependency you already have regressed since install (" + lockfile + "):\n")
		for _, d := range report.Regressed {
			b.WriteString("  • " + d.Name + "@" + d.Version + " → " + d.Baseline + " → " + d.Verdict + "\n")
		}
	}
	if len(report.FlaggedUpdates) > 0 {
		b.WriteString("informational — newer versions available but flagged (don't blind-upgrade):\n")
		for _, f := range report.FlaggedUpdates {
			b.WriteString("  • " + f.Name + " (pinned " + f.Version + ") → newer version guards " + f.Worst + "\n")
		}
	}
	return b.String()
}

// toFileEdits converts hookshot's edit hunks into the guard package's stdlib-only
// mirror type so the diff logic stays importable without the hookshot module.
func toFileEdits(edits []hookshot.FileEdit) []pkgxrayguard.FileEdit {
	out := make([]pkgxrayguard.FileEdit, len(edits))
	for i, e := range edits {
		out[i] = pkgxrayguard.FileEdit{OldString: e.OldString, NewString: e.NewString}
	}
	return out
}

// auditManifestEdit reacts to a dependency-manifest edit. For package.json it
// diffs the edit hunks and deep-guards only the newly added/changed deps
// (reusing the session memo), so an edit doesn't re-triage the whole tree — and
// so a bare formatting/script change triages nothing. When no added dep can be
// extracted it falls back to a full-file audit, so it is never less safe than a
// blanket audit. Lockfiles always take the full-file `pkgxray audit` path, which
// honors the sibling .pkgxray.lock allow/block memory.
func auditManifestEdit(cfg config, filePath string, edits []pkgxrayguard.FileEdit) hookshot.FileEditDecision {
	if filepath.Base(filePath) == "package.json" {
		if specs := pkgxrayguard.ManifestAddedSpecs(edits); len(specs) > 0 {
			return decideManifestSpecs(cfg, filePath, specs)
		}
		// No dependency add/change detected — but fall through to a full audit
		// rather than skipping, so an unusually-formatted addition can't slip by.
	}
	return auditManifestFile(cfg, filePath)
}

// decideMcpConfigEdit diffs an MCP-config edit for added/changed server
// entries and runs each through the same gate as an `mcp add` command —
// launcher packages get the static scan, http(s) URLs get the `pkgxray mcp`
// probe, unreadable entries surface as review-worthy. An edit that adds no
// server (formatting, env tweak) triages nothing. Once the gate clears, the
// vetted stdio entries are wrapped in place behind `pkgxray mcp-proxy` — a
// config file is shared state the hook can rewrite, so the runtime gate is
// adopted without an agent round-trip (see configwrap.go).
func decideMcpConfigEdit(cfg config, filePath string, edits []pkgxrayguard.FileEdit) hookshot.FileEditDecision {
	specs := pkgxrayguard.McpConfigAddedSpecs(edits)
	if len(specs) == 0 {
		return hookshot.FileEditOK()
	}
	action, results := gateAddedSpecs(cfg, specs)
	base := filepath.Base(filePath)
	if action == pkgxrayguard.Deny {
		// A blocked server is being rejected outright — never rewrite it to
		// launch, not even behind the proxy.
		return hookshot.FileEditBlock("pkgxray flagged an MCP server added to " + base + ":" + evidenceLines(results))
	}

	var notes []string
	if action == pkgxrayguard.Ask {
		notes = append(notes, "pkgxray: review recommended for an MCP server added to "+base+":"+evidenceLines(results))
	}
	if cfg.mcpWrap {
		switch wrapped, err := pkgxrayguard.WrapMcpConfigFile(filePath, edits, string(cfg.policy)); {
		case err != nil:
			// A config the hook could not parse (comments, trailing commas) is
			// left untouched; the gate already ran, so surface the skip.
			notes = append(notes, "pkgxray: could not auto-wrap "+base+" ("+err.Error()+") — server(s) registered unwrapped")
		case len(wrapped) > 0:
			notes = append(notes, mcpConfigWrapMessage(base, wrapped, cfg.policy))
		}
	}
	if len(notes) == 0 {
		return hookshot.FileEditOK()
	}
	return hookshot.FileEditAddContext(strings.Join(notes, "\n\n"))
}

// decideManifestSpecs guards the added deps and maps the worst decision onto a
// file-edit outcome. A post-edit hook can't undo the write, so a Deny becomes
// FileEditBlock (honored by Claude) and an Ask becomes added context.
func decideManifestSpecs(cfg config, filePath string, specs []pkgxrayguard.InstallSpec) hookshot.FileEditDecision {
	action, results := gateAddedSpecs(cfg, specs)
	base := filepath.Base(filePath)
	switch action {
	case pkgxrayguard.Deny:
		return hookshot.FileEditBlock("pkgxray flagged a dependency added to " + base + ":" + evidenceLines(results))
	case pkgxrayguard.Ask:
		return hookshot.FileEditAddContext("pkgxray: review recommended for a dependency added to " + base + ":" + evidenceLines(results))
	default:
		return hookshot.FileEditOK()
	}
}

// gateAddedSpecs guards the added specs concurrently and returns the strongest
// policy action plus the per-spec results, so a caller can both decide the
// file-edit outcome and (for a config file it may rewrite) branch on a non-Deny
// clearance.
func gateAddedSpecs(cfg config, specs []pkgxrayguard.InstallSpec) (pkgxrayguard.Action, []pkgxrayguard.Result) {
	results := pkgxrayguard.CheckAll(context.Background(), cfg.checker, specs, cfg.guardWorkers)
	return pkgxrayguard.DecideAll(cfg.policy, results), results
}

// mcpConfigWrapMessage reports the in-place config rewrite back to the agent as
// added context — the config-file counterpart to wrapMessage, but the rewrite
// has already landed, so it is a notice, not an instruction to re-run.
func mcpConfigWrapMessage(base string, wrapped []string, policy pkgxrayguard.Policy) string {
	return "pkgxray: wrapped " + joinNames(wrapped) + " in " + base + " to launch behind " +
		"`pkgxray mcp-proxy --policy " + string(policy) + "` (per-call runtime gate: audits every " +
		"tools/call, re-checks the manifest on tools/list_changed, screens results for injection). " +
		"Requires pkgxray >= 0.17 on PATH at server launch time. Set PKGXRAY_HOOK_MCP_WRAP=0 to " +
		"register servers unwrapped."
}

// joinNames renders wrapped server names as a readable, quoted list.
func joinNames(names []string) string {
	quoted := make([]string, len(names))
	for i, n := range names {
		quoted[i] = "`" + n + "`"
	}
	return strings.Join(quoted, ", ")
}

// evidenceLines renders the non-safe results as indented bullet lines, reusing
// the same ref → verdict → findings shape as the install-command deny message.
func evidenceLines(results []pkgxrayguard.Result) string {
	var b strings.Builder
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
			for _, reason := range r.Reasons {
				b.WriteString("\n      - ")
				b.WriteString(reason)
			}
		}
	}
	return b.String()
}

// auditManifestFile runs `pkgxray audit <file>` on the whole manifest and reports
// the verdict back to the agent.
func auditManifestFile(cfg config, filePath string) hookshot.FileEditDecision {
	out, code := runCLI(cfg.guard.Bin, "audit", filePath)
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
