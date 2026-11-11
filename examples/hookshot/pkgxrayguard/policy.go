package pkgxrayguard

import "strings"

// Policy names remain accepted for configuration compatibility. Every policy
// requires a completed SAFE result; uncertainty never opens an approval prompt.
type Policy string

const (
	Strict     Policy = "strict"
	Balanced   Policy = "balanced"
	Permissive Policy = "permissive"
)

// Action is the binary decision the hook sends to its host.
type Action string

const (
	Allow Action = "allow"
	Deny  Action = "deny"
)

// ParsePolicy resolves a legacy policy name, defaulting to Balanced.
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

// DecideResult denies missing checks and errors even if a scanner labels the
// result SAFE. The guard owns bounded retries; the hook never reruns a scan.
func DecideResult(p Policy, r Result) Action {
	if r.MandatoryHold || r.Err != nil {
		return Deny
	}
	return Decide(p, r.Verdict)
}

// DecideAll allows a command only when every recognized package is allowed.
// An empty list represents an unrelated command, preserving passthrough.
func DecideAll(p Policy, results []Result) Action {
	for _, r := range results {
		if DecideResult(p, r) != Allow {
			return Deny
		}
	}
	return Allow
}

// Decide accepts SAFE alone. Legacy REVIEW, UNKNOWN and future verdicts deny
// under every policy, without claiming that incomplete checks prove malware.
func Decide(_ Policy, v Verdict) Action {
	if v == Safe {
		return Allow
	}
	return Deny
}
