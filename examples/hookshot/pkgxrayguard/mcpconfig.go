package pkgxrayguard

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"
)

// MCP-config file-edit gate.
//
// `… mcp add` is not the only way a server gets registered: an agent can write
// the config file directly (Claude's .mcp.json, Cursor/VS Code's mcp.json,
// Windsurf's mcp_config.json, Claude Desktop's claude_desktop_config.json) and
// bypass the execution gate entirely. OnAfterFileEdit closes that path: the
// edit hunks are diffed for added/changed server entries and each one takes
// the same gate as an `mcp add` would — launcher command → static package
// scan, http(s) URL → `pkgxray mcp` probe, unreadable → Review.
//
// Same honesty rule as the package.json diff: extraction is best-effort, and
// when the hunks clearly define a server we could NOT read, a review-worthy
// sentinel is returned rather than silently allowing it.

// mcpConfigFiles are the config basenames that register MCP servers across
// hosts. settings.json files are deliberately absent — too generic; matching
// them would triage every editor-settings edit.
var mcpConfigFiles = map[string]bool{
	".mcp.json":                  true, // Claude Code (project scope)
	"mcp.json":                   true, // Cursor (.cursor/), VS Code (.vscode/)
	"mcp_config.json":            true, // Windsurf Cascade
	"claude_desktop_config.json": true, // Claude Desktop
}

// IsMcpConfig reports whether the edited file registers MCP servers.
func IsMcpConfig(filePath string) bool {
	return mcpConfigFiles[filepath.Base(filePath)]
}

// mcpServerConfig is the server-entry shape shared by every host's config:
// stdio servers carry command+args, remote servers carry url (+ type/transport
// naming the flavor).
type mcpServerConfig struct {
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	URL       string   `json:"url"`
	Type      string   `json:"type"`
	Transport string   `json:"transport"`
}

func (c mcpServerConfig) isServer() bool { return c.Command != "" || c.URL != "" }

// fingerprint canonicalizes the fields the gate cares about, so an edit that
// only touches a server's env or reformats its JSON does not re-triage it.
func (c mcpServerConfig) fingerprint() string {
	b, _ := json.Marshal(struct {
		Command string   `json:"c"`
		Args    []string `json:"a"`
		URL     string   `json:"u"`
		Type    string   `json:"t"`
	}{c.Command, c.Args, c.URL, strings.ToLower(c.Type + c.Transport)})
	return string(b)
}

// serverKeyRE detects server-defining keys in a raw fragment — the signal that
// an unparseable hunk still registered SOMETHING we should not silently allow.
var serverKeyRE = regexp.MustCompile(`"(?:command|url)"\s*:`)

// McpConfigAddedSpecs diffs MCP-config edit hunks and returns one spec per
// added/changed server entry. A server present identically in the old text is
// unchanged and yields nothing (formatting/env-only edits re-triage nothing).
// When the new text plainly defines a server (a "command"/"url" key) that
// extraction could not read, a review-worthy sentinel spec is returned.
func McpConfigAddedSpecs(edits []FileEdit) []InstallSpec {
	var out []InstallSpec
	seen := make(map[string]bool)
	for _, e := range edits {
		oldPrints := make(map[string]bool)
		for _, s := range extractMcpServers(e.OldString) {
			oldPrints[s.fingerprint()] = true
		}

		servers := extractMcpServers(e.NewString)
		extractedAny := false
		for _, s := range servers {
			if oldPrints[s.fingerprint()] {
				extractedAny = true // read it, and it is unchanged
				continue
			}
			extractedAny = true
			for _, spec := range mcpServerSpecs(s) {
				if seen[spec.Ref] {
					continue
				}
				seen[spec.Ref] = true
				out = append(out, spec)
			}
		}

		// The hunk defines a server we could not extract — never silently
		// allow what we could not read (mirrors the unreadable add-json rule).
		if !extractedAny && serverKeyRE.MatchString(e.NewString) &&
			e.NewString != e.OldString && !seen["mcp-config"] {
			seen["mcp-config"] = true
			out = append(out, InstallSpec{
				Ref:     "mcp-config",
				Manager: "mcp",
				Raw:     clip(e.NewString, 60),
				Kind:    KindMcpSSE, // unreadable → Review, without shelling out
			})
		}
	}
	return out
}

// mcpServerSpecs maps one server entry onto gate specs, reusing the exact
// `mcp add` classification: url → probe/SSE spec, command → the normal
// launcher parse (npx → registry spec, local path → nothing to gate).
func mcpServerSpecs(c mcpServerConfig) []InstallSpec {
	if c.URL != "" {
		transport := c.Type
		if transport == "" {
			transport = c.Transport
		}
		return mcpTargetSpecs([]string{c.URL}, transport)
	}
	return parseSegment(strings.Join(append([]string{c.Command}, c.Args...), " "))
}

// extractMcpServers pulls every server-shaped object out of a JSON fragment.
// Edit hunks are often not a complete document, so it attempts a JSON decode
// at each top-level '{' and recursively walks whatever decodes for objects
// carrying a command/url — this handles a whole-file write, a single pasted
// server entry, and an "mcpServers": {…} block alike.
func extractMcpServers(text string) []mcpServerConfig {
	var servers []mcpServerConfig
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(text[i:]))
		var v any
		if err := dec.Decode(&v); err != nil {
			continue
		}
		collectServers(v, &servers, 0)
		// Skip past the object that just decoded so nested '{' aren't re-tried.
		i += int(dec.InputOffset()) - 1
	}
	return servers
}

func collectServers(v any, out *[]mcpServerConfig, depth int) {
	if depth > 8 {
		return
	}
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	if c := toServerConfig(m); c.isServer() {
		*out = append(*out, c)
		return // a server entry's nested env is not another server
	}
	for _, child := range m {
		collectServers(child, out, depth+1)
	}
}

func toServerConfig(m map[string]any) mcpServerConfig {
	var c mcpServerConfig
	if s, ok := m["command"].(string); ok {
		c.Command = s
	}
	if s, ok := m["url"].(string); ok {
		c.URL = s
	}
	if s, ok := m["type"].(string); ok {
		c.Type = s
	}
	if s, ok := m["transport"].(string); ok {
		c.Transport = s
	}
	if raw, ok := m["args"].([]any); ok {
		for _, a := range raw {
			if s, ok := a.(string); ok {
				c.Args = append(c.Args, s)
			}
		}
	}
	return c
}
