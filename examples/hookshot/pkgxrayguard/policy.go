package pkgxrayguard

import "strings"

// Policy decides how a verdict maps to a hook action.
type Policy string

const (
	// Strict denies BLOCK, REVIEW, and UNKNOWN (fail-closed on any doubt).
	Strict Policy = "strict"
	// Balanced denies BLOCK, asks for confirmation on REVIEW, and denies
	// UNKNOWN so a broken pkgxray never silently fails open. This is the default.
	Balanced Policy = "balanced"
	// Permissive denies only BLOCK; REVIEW and UNKNOWN are allowed through.
	Permissive Policy = "permissive"
)

// Action is what the hook should tell the agent to do.
type Action string

const (
	Allow Action = "allow"
	Ask   Action = "ask"
	Deny  Action = "deny"
)

// ParsePolicy resolves a policy name (case-insensitive), defaulting to Balanced.
func ParsePolicy(s string) Policy {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "strict":
		return Strict
	case "permissive":
		return Permissive
	default:
		return Balanced
	}
}

// DecideResult maps one audited result to an action. It applies the base
// policy, then hardens the fail-mode for execute-immediately specs (npx/bunx/
// pnpm-dlx): those run package code the instant they resolve, with no
// persistent install to inspect afterwards. When we hold no real verdict for
// such a spec — pkgxray errored (Unknown) or the spec is an unvettable VCS/URL
// (Review) — never fail open. Ask at minimum, even under Permissive.
func DecideResult(p Policy, r Result) Action {
	base := Decide(p, r.Verdict)
	if r.Spec.Immediate && base == Allow && (r.Verdict == Unknown || r.Verdict == Review) {
		return Ask
	}
	return base
}

// DecideAll folds per-package results into one command decision: the strongest
// action wins (Deny > Ask > Allow).
func DecideAll(p Policy, results []Result) Action {
	strongest := Allow
	for _, r := range results {
		if actionRank(DecideResult(p, r)) > actionRank(strongest) {
			strongest = DecideResult(p, r)
		}
	}
	return strongest
}

func actionRank(a Action) int {
	switch a {
	case Deny:
		return 2
	case Ask:
		return 1
	default: // Allow
		return 0
	}
}

// Decide maps a verdict to an action under the given policy.
func Decide(p Policy, v Verdict) Action {
	switch v {
	case Block:
		return Deny
	case Review:
		switch p {
		case Strict:
			return Deny
		case Permissive:
			return Allow
		default:
			return Ask
		}
	case Unknown:
		if p == Permissive {
			return Allow
		}
		return Deny
	default: // Safe
		return Allow
	}
}
