package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CorridorSecurity/hookshot"
	"github.com/CorridorSecurity/hookshot/examples/pkgxray-guard/pkgxrayguard"
)

func TestEveryHostAskBecomesDenied(t *testing.T) {
	for _, platform := range []hookshot.Platform{hookshot.PlatformClaude, hookshot.PlatformCursor, hookshot.PlatformCodex, hookshot.PlatformCascade, hookshot.PlatformDroid, "future-host", ""} {
		decision := hostExecutionDecision(platform, hookshot.AskExecution("human review required"))
		if decision.Allow || decision.Ask || decision.Reason != "human review required" {
			t.Fatalf("%s: %+v", platform, decision)
		}
	}
}

type fixedChecker struct{ result pkgxrayguard.Result }

func (c fixedChecker) Check(_ context.Context, spec pkgxrayguard.InstallSpec) pkgxrayguard.Result {
	r := c.result
	r.Spec = spec
	return r
}

func TestNoPolicyPromptsOrAllowsUncertainInstallAndConfigEdits(t *testing.T) {
	for _, policy := range []pkgxrayguard.Policy{pkgxrayguard.Strict, pkgxrayguard.Balanced, pkgxrayguard.Permissive} {
		for _, result := range []pkgxrayguard.Result{
			{Verdict: pkgxrayguard.Review}, {Verdict: pkgxrayguard.Unknown}, {Verdict: pkgxrayguard.Block},
			{Verdict: pkgxrayguard.Safe, Err: errors.New("incomplete scan")},
			{Verdict: pkgxrayguard.Safe, MandatoryHold: true},
		} {
			cfg := config{policy: policy, checker: fixedChecker{result}, mcpWrap: true, guardWorkers: 1}
			specs := []pkgxrayguard.InstallSpec{{Ref: "npm:inert-fixture"}}
			d := decideInstalls(cfg, specs)
			if d.Allow || d.Ask || strings.Contains(d.Reason, "permissive to override") {
				t.Fatalf("%s %+v: install %+v", policy, result, d)
			}
			if d := decideManifestSpecs(cfg, "package.json", specs); !d.Block {
				t.Fatalf("%s %+v: dependency edit %+v", policy, result, d)
			}
			edits := []pkgxrayguard.FileEdit{{NewString: `{"mcpServers":{"fixture":{"command":"npx","args":["inert-fixture"]}}}`}}
			if d := decideMcpConfigEdit(cfg, "does-not-exist/.mcp.json", edits); !d.Block || d.Context != "" {
				t.Fatalf("%s %+v: config edit %+v", policy, result, d)
			}
		}
	}
}

func TestManifestAuditLegacyReviewAndFailuresBlock(t *testing.T) {
	for _, code := range []int{0, 1, 2, 3, 127} {
		bin := filepath.Join(t.TempDir(), "pkgxray")
		if err := os.WriteFile(bin, []byte(fmt.Sprintf("#!/bin/sh\nprintf 'inert fixture\\n'\nexit %d\n", code)), 0700); err != nil {
			t.Fatal(err)
		}
		d := auditManifestFile(config{guard: pkgxrayguard.Guard{Bin: bin}}, "package-lock.json")
		if d.Block != (code != 0) || d.Context != "" {
			t.Fatalf("exit %d: %+v", code, d)
		}
	}
	d := auditManifestFile(config{guard: pkgxrayguard.Guard{Bin: "/nonexistent/pkgxray"}}, "package-lock.json")
	if !d.Block {
		t.Fatal("missing scanner was allowed")
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
	if !server.Block || !strings.Contains(server.Reason, "flagged") || server.Context != "" {
		t.Fatalf("server review was allowed/wrapped: %+v", server)
	}
}
