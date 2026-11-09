package main

import (
	"context"
	"strings"
	"testing"

	"github.com/CorridorSecurity/hookshot"
	"github.com/CorridorSecurity/hookshot/examples/pkgxray-guard/pkgxrayguard"
)

func TestUnsupportedHostAskRemainsDenied(t *testing.T) {
	for _, platform := range []hookshot.Platform{hookshot.PlatformCodex, hookshot.PlatformCascade, hookshot.PlatformDroid, "future-host", ""} {
		decision := hostExecutionDecision(platform, hookshot.AskExecution("human review required"))
		if decision.Allow || decision.Ask || decision.Reason != "human review required" {
			t.Fatalf("%s: %+v", platform, decision)
		}
	}
	for _, platform := range []hookshot.Platform{hookshot.PlatformClaude, hookshot.PlatformCursor} {
		decision := hostExecutionDecision(platform, hookshot.AskExecution("human review required"))
		if decision.Allow || !decision.Ask {
			t.Fatalf("%s did not retain enforced approval prompt", platform)
		}
	}
}

type reviewChecker struct{}

func (reviewChecker) Check(_ context.Context, spec pkgxrayguard.InstallSpec) pkgxrayguard.Result {
	return pkgxrayguard.Result{Spec: spec, Verdict: pkgxrayguard.Review, Summary: "inert fixture needs review"}
}

func TestFileEditReviewDoesNotDowngradeToContextOrWrap(t *testing.T) {
	cfg := config{policy: pkgxrayguard.Balanced, checker: reviewChecker{}, mcpWrap: true, guardWorkers: 1}
	dependency := decideManifestSpecs(cfg, "package.json", []pkgxrayguard.InstallSpec{{Ref: "npm:inert-fixture"}})
	if !dependency.Block || dependency.Context != "" {
		t.Fatalf("dependency review was allowed: %+v", dependency)
	}
	edits := []pkgxrayguard.FileEdit{{NewString: `{"mcpServers":{"fixture":{"command":"npx","args":["inert-fixture"]}}}`}}
	server := decideMcpConfigEdit(cfg, "does-not-exist/.mcp.json", edits)
	if !server.Block || !strings.Contains(server.Reason, "requires review") || server.Context != "" {
		t.Fatalf("server review was allowed/wrapped: %+v", server)
	}
}
