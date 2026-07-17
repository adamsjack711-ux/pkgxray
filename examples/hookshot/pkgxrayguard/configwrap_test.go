package pkgxrayguard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// serverEntry decodes one server object out of a wrapped document for assertions.
func serverEntry(t *testing.T, out []byte, path ...string) map[string]any {
	t.Helper()
	var doc any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	cur := doc
	for _, k := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			t.Fatalf("path %v: %q is not an object", path, k)
		}
		cur = m[k]
	}
	m, ok := cur.(map[string]any)
	if !ok {
		t.Fatalf("path %v does not resolve to an object", path)
	}
	return m
}

func stringSlice(t *testing.T, v any) []string {
	t.Helper()
	raw, ok := v.([]any)
	if !ok {
		t.Fatalf("expected an array, got %T", v)
	}
	out := make([]string, len(raw))
	for i, e := range raw {
		out[i], _ = e.(string)
	}
	return out
}

func TestWrapMcpConfigBytesWrapsStdioLeavesURL(t *testing.T) {
	in := `{
  "mcpServers": {
    "weather": {"command": "npx", "args": ["weather-mcp@1.2.0"], "env": {"KEY": "v"}},
    "remote": {"url": "https://example.com/mcp", "type": "http"}
  }
}`
	out, wrapped, err := WrapMcpConfigBytes([]byte(in), nil, "strict")
	if err != nil {
		t.Fatalf("WrapMcpConfigBytes: %v", err)
	}
	if !reflect.DeepEqual(wrapped, []string{"weather"}) {
		t.Fatalf("wrapped = %v, want [weather]", wrapped)
	}

	weather := serverEntry(t, out, "mcpServers", "weather")
	if weather["command"] != "pkgxray" {
		t.Errorf("command = %v, want pkgxray", weather["command"])
	}
	gotArgs := stringSlice(t, weather["args"])
	wantArgs := []string{"mcp-proxy", "--policy", "strict", "--", "npx", "weather-mcp@1.2.0"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Errorf("args = %v, want %v", gotArgs, wantArgs)
	}
	// Sibling keys ride along untouched.
	env, ok := weather["env"].(map[string]any)
	if !ok || env["KEY"] != "v" {
		t.Errorf("env not preserved: %v", weather["env"])
	}

	// The URL server is not a stdio launcher — left exactly as written.
	remote := serverEntry(t, out, "mcpServers", "remote")
	if remote["url"] != "https://example.com/mcp" || remote["command"] != nil {
		t.Errorf("URL server was mutated: %v", remote)
	}
}

func TestWrapMcpConfigBytesIdempotent(t *testing.T) {
	in := `{"mcpServers":{"weather":{"command":"npx","args":["weather-mcp"]}}}`
	once, wrapped, err := WrapMcpConfigBytes([]byte(in), nil, "balanced")
	if err != nil || len(wrapped) != 1 {
		t.Fatalf("first wrap: err=%v wrapped=%v", err, wrapped)
	}
	twice, wrapped2, err := WrapMcpConfigBytes(once, nil, "balanced")
	if err != nil {
		t.Fatalf("second wrap: %v", err)
	}
	if len(wrapped2) != 0 {
		t.Errorf("already-wrapped entry re-wrapped: %v", wrapped2)
	}
	// A no-op returns the input bytes unchanged.
	if !reflect.DeepEqual(once, twice) {
		t.Errorf("idempotent wrap changed the document:\n%s\n---\n%s", once, twice)
	}
}

func TestWrapMcpConfigBytesEmptyPolicyDefaults(t *testing.T) {
	in := `{"mcpServers":{"w":{"command":"npx","args":["w"]}}}`
	out, _, err := WrapMcpConfigBytes([]byte(in), nil, "")
	if err != nil {
		t.Fatalf("WrapMcpConfigBytes: %v", err)
	}
	args := stringSlice(t, serverEntry(t, out, "mcpServers", "w")["args"])
	if len(args) < 3 || args[2] != "balanced" {
		t.Errorf("empty policy did not default to balanced: %v", args)
	}
}

func TestWrapMcpConfigBytesTargetsFilter(t *testing.T) {
	in := `{"mcpServers":{
		"a":{"command":"npx","args":["a-mcp"]},
		"b":{"command":"npx","args":["b-mcp"]}
	}}`
	// Only server "a" is in the target set.
	target := mcpServerConfig{Command: "npx", Args: []string{"a-mcp"}}
	out, wrapped, err := WrapMcpConfigBytes([]byte(in), map[string]bool{target.fingerprint(): true}, "balanced")
	if err != nil {
		t.Fatalf("WrapMcpConfigBytes: %v", err)
	}
	if !reflect.DeepEqual(wrapped, []string{"a"}) {
		t.Fatalf("wrapped = %v, want [a]", wrapped)
	}
	if serverEntry(t, out, "mcpServers", "b")["command"] != "npx" {
		t.Errorf("non-targeted server b was wrapped")
	}
}

func TestWrapMcpConfigBytesRejectsNonJSON(t *testing.T) {
	// Trailing comma — valid in some editors, not strict JSON.
	_, _, err := WrapMcpConfigBytes([]byte(`{"mcpServers":{"w":{"command":"npx",}}}`), nil, "balanced")
	if err == nil {
		t.Fatal("expected an error for non-strict JSON, got nil")
	}
	if !strings.Contains(err.Error(), "strict JSON") {
		t.Errorf("error should mention strict JSON, got: %v", err)
	}
}

func TestWrapConfigTargetsFromEdits(t *testing.T) {
	// The old text already had server "keep"; the edit adds "new" (stdio) and
	// "remote" (URL). Only the added stdio entry is a wrap target.
	old := `{"mcpServers":{"keep":{"command":"npx","args":["keep-mcp"]}}}`
	updated := `{"mcpServers":{
		"keep":{"command":"npx","args":["keep-mcp"]},
		"new":{"command":"npx","args":["new-mcp"]},
		"remote":{"url":"https://x/mcp"}
	}}`
	targets := wrapConfigTargets([]FileEdit{{OldString: old, NewString: updated}})
	if len(targets) != 1 {
		t.Fatalf("targets = %v, want exactly the added stdio entry", targets)
	}
	added := mcpServerConfig{Command: "npx", Args: []string{"new-mcp"}}
	if !targets[added.fingerprint()] {
		t.Errorf("added stdio server not targeted; got %v", targets)
	}
	unchanged := mcpServerConfig{Command: "npx", Args: []string{"keep-mcp"}}
	if targets[unchanged.fingerprint()] {
		t.Errorf("unchanged server should not be a target")
	}
}

func TestWrapMcpConfigFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".mcp.json")
	in := `{"mcpServers":{"weather":{"command":"npx","args":["weather-mcp"]}}}`
	if err := os.WriteFile(path, []byte(in), 0o600); err != nil {
		t.Fatal(err)
	}

	// nil edits = wrap every unwrapped stdio entry (the wrap-config path).
	wrapped, err := WrapMcpConfigFile(path, nil, "balanced")
	if err != nil {
		t.Fatalf("WrapMcpConfigFile: %v", err)
	}
	if !reflect.DeepEqual(wrapped, []string{"weather"}) {
		t.Fatalf("wrapped = %v, want [weather]", wrapped)
	}

	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if serverEntry(t, out, "mcpServers", "weather")["command"] != "pkgxray" {
		t.Errorf("file was not rewritten on disk:\n%s", out)
	}
	// File mode is preserved across the rewrite.
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}

	// Second run is a no-op: nothing new to wrap, no write, no names.
	wrapped2, err := WrapMcpConfigFile(path, nil, "balanced")
	if err != nil {
		t.Fatalf("second WrapMcpConfigFile: %v", err)
	}
	if len(wrapped2) != 0 {
		t.Errorf("second run wrapped %v, want none", wrapped2)
	}
}

func TestWrapMcpConfigFileNoTargetsSkipsRead(t *testing.T) {
	// With edits that add no wrappable stdio server, the file is never opened,
	// so a non-existent path is not an error.
	wrapped, err := WrapMcpConfigFile(filepath.Join(t.TempDir(), "absent.json"),
		[]FileEdit{{OldString: "", NewString: `{"mcpServers":{"r":{"url":"https://x/mcp"}}}`}}, "balanced")
	if err != nil {
		t.Fatalf("expected no error when there are no targets, got %v", err)
	}
	if len(wrapped) != 0 {
		t.Errorf("wrapped = %v, want none", wrapped)
	}
}
