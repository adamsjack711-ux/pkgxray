package pkgxrayguard

import (
	"context"
	"testing"
)

// --- parsing: `mcp add` shapes ------------------------------------------------

func TestParseMcpAddHTTPURL(t *testing.T) {
	for _, cmd := range []string{
		"claude mcp add docs https://mcp.example.com/mcp",
		"claude mcp add --transport http docs https://mcp.example.com/mcp",
		"claude mcp add -t http --scope user docs https://mcp.example.com/mcp",
		"claude mcp add docs https://mcp.example.com/mcp --header 'X-Api-Key: abc'",
	} {
		specs := ParseInstalls(cmd)
		if len(specs) != 1 {
			t.Fatalf("%q: got %d specs, want 1: %+v", cmd, len(specs), specs)
		}
		if specs[0].Kind != KindMcpHTTP || specs[0].Ref != "https://mcp.example.com/mcp" {
			t.Errorf("%q: got %+v", cmd, specs[0])
		}
	}
}

func TestParseMcpAddSSEIsUnvettable(t *testing.T) {
	specs := ParseInstalls("claude mcp add --transport sse legacy https://old.example.com/sse")
	if len(specs) != 1 || specs[0].Kind != KindMcpSSE {
		t.Fatalf("got %+v, want one KindMcpSSE spec", specs)
	}
}

func TestParseMcpAddStdioLauncherTakesPackagePath(t *testing.T) {
	// With and without the `--` separator, the launcher package must surface
	// as a normal registry spec (static scan path — the hook never spawns it).
	for _, cmd := range []string{
		"claude mcp add weather -- npx weather-mcp-server",
		"claude mcp add weather npx weather-mcp-server",
	} {
		specs := ParseInstalls(cmd)
		if len(specs) != 1 {
			t.Fatalf("%q: got %d specs, want 1: %+v", cmd, len(specs), specs)
		}
		if specs[0].Kind != KindRegistry || specs[0].Ref != "npm:weather-mcp-server" {
			t.Errorf("%q: got %+v", cmd, specs[0])
		}
	}
}

func TestParseMcpAddFlagValuesDoNotBecomePositionals(t *testing.T) {
	// "http" (the --transport value) and the -e value must not be mistaken for
	// the server name/target.
	specs := ParseInstalls("claude mcp add --transport http -e KEY=val srv https://x.example/mcp")
	if len(specs) != 1 || specs[0].Ref != "https://x.example/mcp" {
		t.Fatalf("got %+v", specs)
	}
}

func TestParseMcpAddLocalCommandYieldsNothing(t *testing.T) {
	// A local binary path is already-visible code — same rule as local installs.
	if specs := ParseInstalls("claude mcp add local -- /usr/local/bin/my-server --flag"); len(specs) != 0 {
		t.Fatalf("got %+v, want none", specs)
	}
}

func TestParseMcpAddJSONForms(t *testing.T) {
	specs := ParseInstalls(`claude mcp add-json docs '{"type":"http","url":"https://mcp.example.com/mcp"}'`)
	if len(specs) != 1 || specs[0].Kind != KindMcpHTTP {
		t.Fatalf("http json: got %+v", specs)
	}

	specs = ParseInstalls(`claude mcp add-json weather '{"command":"npx","args":["weather-mcp-server"]}'`)
	if len(specs) != 1 || specs[0].Ref != "npm:weather-mcp-server" {
		t.Fatalf("command json: got %+v", specs)
	}

	// Unreadable JSON registers something we could not inspect — review-worthy.
	specs = ParseInstalls(`claude mcp add-json broken 'not-json'`)
	if len(specs) != 1 || specs[0].Kind != KindMcpSSE {
		t.Fatalf("broken json: got %+v", specs)
	}
}

func TestParseMcpAddDoesNotMisfireOnOrdinaryCommands(t *testing.T) {
	for _, cmd := range []string{
		"npm install express",
		"git mcp-something add x",
		"claude mcp list",
		"claude mcp remove docs",
	} {
		for _, s := range ParseInstalls(cmd) {
			if s.Kind == KindMcpHTTP || s.Kind == KindMcpSSE {
				t.Errorf("%q: unexpected MCP spec %+v", cmd, s)
			}
		}
	}
}

// --- probe: checkMcp ----------------------------------------------------------

func TestCheckMcpSSEIsReviewWithoutShellingOut(t *testing.T) {
	g := Guard{Bin: "/nonexistent/pkgxray"} // would error if executed
	res := g.Check(context.Background(), InstallSpec{Ref: "https://old.example/sse", Kind: KindMcpSSE})
	if res.Verdict != Review || res.Err != nil {
		t.Fatalf("got %+v, want Review with no error", res)
	}
}

func TestCheckMcpProbeDisabledIsReview(t *testing.T) {
	g := Guard{Bin: "/nonexistent/pkgxray", DisableMcpProbe: true}
	res := g.Check(context.Background(), InstallSpec{Ref: "https://x.example/mcp", Kind: KindMcpHTTP})
	if res.Verdict != Review {
		t.Fatalf("got %+v, want Review", res)
	}
}

func TestCheckMcpParsesVerdictAndEvidence(t *testing.T) {
	out := `{
	  "verdict": "block",
	  "manifest": {"server": {"name": "evil-docs", "version": "1.0.0"}, "tools": [{"name": "get_weather"}]},
	  "manifestAudit": {"findings": [
	    {"severity": "high", "category": "capability-mismatch", "rationale": "narrow purpose, exec param", "file": "mcp-manifest/tool-get_weather.md"}
	  ]}
	}`
	g := Guard{Bin: fakePkgxray(t, out, 2)}
	res := g.Check(context.Background(), InstallSpec{Ref: "https://x.example/mcp", Kind: KindMcpHTTP})
	if res.Verdict != Block {
		t.Fatalf("verdict = %s, want block (%+v)", res.Verdict, res)
	}
	if res.Summary != "MCP manifest audit: evil-docs@1.0.0, 1 tools" {
		t.Errorf("summary = %q", res.Summary)
	}
	if len(res.Reasons) != 1 || res.Reasons[0] != "[capability-mismatch] narrow purpose, exec param (mcp-manifest/tool-get_weather.md)" {
		t.Errorf("reasons = %+v", res.Reasons)
	}
}

func TestCheckMcpExitCodeFallback(t *testing.T) {
	g := Guard{Bin: fakePkgxray(t, "not json", 3)}
	res := g.Check(context.Background(), InstallSpec{Ref: "https://x.example/mcp", Kind: KindMcpHTTP})
	if res.Verdict != Review {
		t.Fatalf("got %s, want review from exit code 3", res.Verdict)
	}
}

func TestCheckMcpEngineUnreachableIsUnknownAndFailsClosed(t *testing.T) {
	g := Guard{Bin: "/nonexistent/pkgxray"}
	res := g.Check(context.Background(), InstallSpec{Ref: "https://x.example/mcp", Kind: KindMcpHTTP})
	if res.Verdict != Unknown || res.Err == nil {
		t.Fatalf("got %+v, want Unknown with error", res)
	}
	if got := Decide(Balanced, res.Verdict); got != Deny {
		t.Fatalf("balanced policy on Unknown = %s, want deny", got)
	}
}
