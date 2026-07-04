package pkgxrayguard

import "testing"

func TestIsMcpConfig(t *testing.T) {
	yes := []string{
		"/proj/.mcp.json",
		"/proj/.cursor/mcp.json",
		"/proj/.vscode/mcp.json",
		"/home/u/.codeium/windsurf/mcp_config.json",
		"/Users/u/Library/Application Support/Claude/claude_desktop_config.json",
	}
	no := []string{
		"/proj/package.json",
		"/proj/.vscode/settings.json",
		"/proj/tsconfig.json",
		"/proj/mcp.json.bak",
	}
	for _, p := range yes {
		if !IsMcpConfig(p) {
			t.Errorf("IsMcpConfig(%q) = false, want true", p)
		}
	}
	for _, p := range no {
		if IsMcpConfig(p) {
			t.Errorf("IsMcpConfig(%q) = true, want false", p)
		}
	}
}

func cfgSpecRefs(specs []InstallSpec) []string {
	refs := make([]string, len(specs))
	for i, s := range specs {
		refs[i] = s.Ref
	}
	return refs
}

func TestMcpConfigWholeFileWriteExtractsServers(t *testing.T) {
	// A Write-tool style whole-file write: full valid JSON.
	specs := McpConfigAddedSpecs([]FileEdit{{
		OldString: "",
		NewString: `{
		  "mcpServers": {
		    "weather": {"command": "npx", "args": ["weather-mcp-server"], "env": {"K": "v"}},
		    "docs": {"type": "http", "url": "https://mcp.example.com/mcp"}
		  }
		}`,
	}})
	if len(specs) != 2 {
		t.Fatalf("got %v, want 2 specs", cfgSpecRefs(specs))
	}
	byRef := map[string]InstallSpec{}
	for _, s := range specs {
		byRef[s.Ref] = s
	}
	if s, ok := byRef["npm:weather-mcp-server"]; !ok || s.Kind != KindRegistry {
		t.Errorf("stdio launcher spec missing/wrong: %+v", specs)
	}
	if s, ok := byRef["https://mcp.example.com/mcp"]; !ok || s.Kind != KindMcpHTTP {
		t.Errorf("http url spec missing/wrong: %+v", specs)
	}
}

func TestMcpConfigPartialHunkWithOneServerEntry(t *testing.T) {
	// An Edit-tool hunk pasting just the server object.
	specs := McpConfigAddedSpecs([]FileEdit{{
		OldString: "",
		NewString: `"evil": {"command": "npx", "args": ["evil-mcp@1.2.3"]}`,
	}})
	if len(specs) != 1 || specs[0].Ref != "npm:evil-mcp@1.2.3" {
		t.Fatalf("got %v", cfgSpecRefs(specs))
	}
}

func TestMcpConfigUnchangedServerYieldsNothing(t *testing.T) {
	server := `{"mcpServers": {"weather": {"command": "npx", "args": ["weather-mcp-server"]}}}`
	// Env/reformatting edit: same command/args/url fingerprint on both sides.
	specs := McpConfigAddedSpecs([]FileEdit{{
		OldString: server,
		NewString: `{"mcpServers": {"weather": {"command": "npx", "args": ["weather-mcp-server"], "env": {"NEW": "1"}}}}`,
	}})
	if len(specs) != 0 {
		t.Fatalf("env-only edit re-triaged: %v", cfgSpecRefs(specs))
	}
}

func TestMcpConfigChangedArgsRetriages(t *testing.T) {
	specs := McpConfigAddedSpecs([]FileEdit{{
		OldString: `{"weather": {"command": "npx", "args": ["weather-mcp-server"]}}`,
		NewString: `{"weather": {"command": "npx", "args": ["weather-mcp-server-evil"]}}`,
	}})
	if len(specs) != 1 || specs[0].Ref != "npm:weather-mcp-server-evil" {
		t.Fatalf("got %v", cfgSpecRefs(specs))
	}
}

func TestMcpConfigSSETransportIsUnvettable(t *testing.T) {
	specs := McpConfigAddedSpecs([]FileEdit{{
		OldString: "",
		NewString: `{"legacy": {"transport": "sse", "url": "https://old.example.com/sse"}}`,
	}})
	if len(specs) != 1 || specs[0].Kind != KindMcpSSE {
		t.Fatalf("got %+v", specs)
	}
}

func TestMcpConfigLocalCommandYieldsNothing(t *testing.T) {
	specs := McpConfigAddedSpecs([]FileEdit{{
		OldString: "",
		NewString: `{"local": {"command": "/usr/local/bin/my-server", "args": ["--flag"]}}`,
	}})
	if len(specs) != 0 {
		t.Fatalf("local command gated: %v", cfgSpecRefs(specs))
	}
}

func TestMcpConfigUnreadableServerFragmentIsSentinel(t *testing.T) {
	// Truncated hunk: plainly defines a server, but no complete object parses.
	specs := McpConfigAddedSpecs([]FileEdit{{
		OldString: "",
		NewString: `"evil": {"command": "npx", "args": ["evil-mcp",`,
	}})
	if len(specs) != 1 || specs[0].Kind != KindMcpSSE || specs[0].Ref != "mcp-config" {
		t.Fatalf("got %+v, want the unreadable sentinel", specs)
	}
}

func TestMcpConfigFormattingEditYieldsNothing(t *testing.T) {
	specs := McpConfigAddedSpecs([]FileEdit{{
		OldString: `{"mcpServers": {}}`,
		NewString: `{"mcpServers": {}, "otherSetting": true}`,
	}})
	if len(specs) != 0 {
		t.Fatalf("got %v, want none", cfgSpecRefs(specs))
	}
}

func TestMcpConfigDuplicateServersDedupe(t *testing.T) {
	specs := McpConfigAddedSpecs([]FileEdit{
		{NewString: `{"a": {"command": "npx", "args": ["same-server"]}}`},
		{NewString: `{"b": {"command": "npx", "args": ["same-server"]}}`},
	})
	if len(specs) != 1 {
		t.Fatalf("got %v, want deduped single spec", cfgSpecRefs(specs))
	}
}
