package pkgxrayguard

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"sort"
)

// Config-file auto-wrap — the counterpart to WrapMcpAdd for servers registered
// by editing a config file directly (.mcp.json & friends).
//
// A command rewrite has to travel back to the agent as a deny reason, because
// hookshot decisions cannot substitute a command. A config file is different:
// by the time OnAfterFileEdit fires the write has already landed, and the file
// is shared state the hook CAN touch. So after the gate clears the added
// entries, the hook rewrites the stdio ones in place to launch through
// `pkgxray mcp-proxy --policy <p>` and reports what changed as added context —
// zero extra agent round-trips, and the very next session that starts the
// server runs behind the per-call runtime gate.
//
// The rewrite touches ONLY server entries (command+args); env, cwd, type and
// every other key ride along untouched. The document is re-emitted as
// canonical two-space-indented JSON, which is how the host CLIs write these
// files themselves. A file that does not parse as strict JSON (comments,
// trailing commas) is never modified — the caller surfaces the skip instead.

// wrapConfigTargets returns the fingerprints of the stdio server entries the
// edit hunks added or changed — the same diff McpConfigAddedSpecs gates,
// minus entries the proxy cannot or need not wrap (URL servers, entries
// already behind the proxy).
func wrapConfigTargets(edits []FileEdit) map[string]bool {
	targets := make(map[string]bool)
	for _, e := range edits {
		oldPrints := make(map[string]bool)
		for _, s := range extractMcpServers(e.OldString) {
			oldPrints[s.fingerprint()] = true
		}
		for _, s := range extractMcpServers(e.NewString) {
			if oldPrints[s.fingerprint()] || !s.wrappable() {
				continue
			}
			targets[s.fingerprint()] = true
		}
	}
	return targets
}

// wrappable reports whether an entry is a stdio server not already launching
// through the runtime gate.
func (c mcpServerConfig) wrappable() bool {
	if c.Command == "" || c.URL != "" {
		return false
	}
	return !isProxyWrapped(append([]string{c.Command}, c.Args...))
}

// WrapMcpConfigFile rewrites stdio server entries in an MCP config file to
// launch through `pkgxray mcp-proxy --policy <p>`. With edits, only the
// entries those hunks added or changed are wrapped (the post-edit hook path);
// with nil edits, every unwrapped stdio entry is (the wrap-config
// subcommand). Returns the names of the wrapped entries; the file is written
// only when at least one entry changed.
func WrapMcpConfigFile(path string, edits []FileEdit, policy string) ([]string, error) {
	var targets map[string]bool
	if edits != nil {
		targets = wrapConfigTargets(edits)
		if len(targets) == 0 {
			return nil, nil
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out, wrapped, err := WrapMcpConfigBytes(raw, targets, policy)
	if err != nil || len(wrapped) == 0 {
		return nil, err
	}
	mode := fs.FileMode(0o644)
	if info, statErr := os.Stat(path); statErr == nil {
		mode = info.Mode().Perm()
	}
	if err := os.WriteFile(path, out, mode); err != nil {
		return nil, err
	}
	return wrapped, nil
}

// WrapMcpConfigBytes is the pure transform behind WrapMcpConfigFile: wrap the
// stdio server entries whose fingerprint is in targets (nil targets = every
// unwrapped stdio entry) and re-emit the document. When nothing matches, the
// input bytes are returned unchanged with no wrapped names.
func WrapMcpConfigBytes(raw []byte, targets map[string]bool, policy string) ([]byte, []string, error) {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, nil, errors.New("config is not strict JSON (comments? trailing comma?): " + err.Error())
	}
	if policy == "" {
		policy = "balanced"
	}
	var wrapped []string
	wrapServersInDoc(doc, "", targets, policy, &wrapped, 0)
	if len(wrapped) == 0 {
		return raw, nil, nil
	}
	sort.Strings(wrapped)

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return nil, nil, err
	}
	return buf.Bytes(), wrapped, nil
}

// wrapServersInDoc mirrors collectServers' walk, but mutates matching server
// entries in place. name is the key the entry sits under in its parent map —
// the server's registered name — used purely for reporting.
func wrapServersInDoc(v any, name string, targets map[string]bool, policy string, wrapped *[]string, depth int) {
	if depth > 8 {
		return
	}
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	if c := toServerConfig(m); c.isServer() {
		if !c.wrappable() || (targets != nil && !targets[c.fingerprint()]) {
			return
		}
		args := []any{"mcp-proxy", "--policy", policy, "--", c.Command}
		for _, a := range c.Args {
			args = append(args, a)
		}
		m["command"] = "pkgxray"
		m["args"] = args
		if name == "" {
			name = c.Command
		}
		*wrapped = append(*wrapped, name)
		return // a server entry's nested env is not another server
	}
	for k, child := range m {
		wrapServersInDoc(child, k, targets, policy, wrapped, depth+1)
	}
}
