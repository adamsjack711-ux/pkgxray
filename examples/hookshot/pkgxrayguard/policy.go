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
