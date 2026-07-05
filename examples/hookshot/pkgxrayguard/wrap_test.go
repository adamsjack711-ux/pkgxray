package pkgxrayguard

import (
	"strings"
	"testing"
)

func TestWrapMcpAddRewrites(t *testing.T) {
	cases := []struct {
		name    string
		command string
		policy  string
		want    string
	}{
		{
			name:    "with dash-dash",
			command: "claude mcp add weather -- npx weather-mcp",
			policy:  "balanced",
			want:    "claude mcp add weather -- pkgxray mcp-proxy --policy balanced -- npx weather-mcp",
		},
		{
			name:    "without dash-dash gains one",
			command: "claude mcp add weather npx weather-mcp",
			policy:  "balanced",
			want:    "claude mcp add weather -- pkgxray mcp-proxy --policy balanced -- npx weather-mcp",
		},
		{
			name:    "host flags and their values survive in place",
			command: "claude mcp add -s user -e KEY=v weather -- npx weather-mcp@1.2.0",
			policy:  "strict",
			want:    "claude mcp add -s user -e KEY=v weather -- pkgxray mcp-proxy --policy strict -- npx weather-mcp@1.2.0",
		},
		{
			name:    "local binary launcher (unvettable statically) still wraps",
			command: "claude mcp add local -- /opt/srv/bin/server --port 3",
			policy:  "balanced",
			want:    "claude mcp add local -- pkgxray mcp-proxy --policy balanced -- /opt/srv/bin/server --port 3",
		},
		{
			name:    "empty policy defaults to balanced",
			command: "cursor mcp add tools -- bunx tools-mcp",
			policy:  "",
			want:    "cursor mcp add tools -- pkgxray mcp-proxy --policy balanced -- bunx tools-mcp",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := WrapMcpAdd(tc.command, tc.policy)
			if !ok {
				t.Fatalf("expected a rewrite for %q", tc.command)
			}
			if got != tc.want {
				t.Fatalf("wrap mismatch:\n  got  %q\n  want %q", got, tc.want)
			}
		})
	}
}

func TestWrapMcpAddRequotesTokensWithSpaces(t *testing.T) {
	got, ok := WrapMcpAdd(`claude mcp add -e "KEY=has space" weather -- npx weather-mcp`, "balanced")
	if !ok {
		t.Fatal("expected a rewrite")
	}
	if !strings.Contains(got, "'KEY=has space'") {
		t.Fatalf("expected the spaced env value re-quoted, got %q", got)
	}
}

func TestWrapMcpAddDeclines(t *testing.T) {
	cases := []struct {
		name    string
		command string
	}{
		{"http url target", "claude mcp add api https://mcp.example.com/mcp"},
		{"http url after transport flag", "claude mcp add --transport http api https://mcp.example.com/mcp"},
		{"already wrapped", "claude mcp add weather -- pkgxray mcp-proxy --policy balanced -- npx weather-mcp"},
		{"already wrapped via path", "claude mcp add weather -- /usr/local/bin/pkgxray mcp-proxy -- npx weather-mcp"},
		{"add-json (quoted JSON not rebuilt)", `claude mcp add-json weather '{"command":"npx","args":["weather-mcp"]}'`},
		{"compound command", "cd /tmp && claude mcp add weather -- npx weather-mcp"},
		{"not an mcp add", "npm install express"},
		{"mcp add with no target", "claude mcp add weather"},
		{"plain npx run", "npx create-react-app my-app"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, ok := WrapMcpAdd(tc.command, "balanced"); ok {
				t.Fatalf("expected no rewrite, got %q", got)
			}
		})
	}
}

// The other half of the loop: when the agent re-runs the wrapped command, the
// INNER launcher must still parse to a package spec so the static scan
// applies to what will actually run.
func TestWrappedTargetStillScansInnerLauncher(t *testing.T) {
	specs := ParseInstalls("claude mcp add weather -- pkgxray mcp-proxy --policy balanced -- npx weather-mcp@1.2.0")
	if len(specs) != 1 {
		t.Fatalf("expected 1 spec, got %d: %+v", len(specs), specs)
	}
	if specs[0].Ref != "npm:weather-mcp@1.2.0" {
		t.Fatalf("expected the inner launcher's registry ref, got %q", specs[0].Ref)
	}
	if !specs[0].Immediate {
		t.Fatal("npx launcher should keep its execute-immediately fail-mode")
	}
}

func TestWrappedTargetWithValueFlagsUnwraps(t *testing.T) {
	specs := ParseInstalls("claude mcp add w -- pkgxray mcp-proxy --lock /tmp/x.lock --timing -- npx weather-mcp")
	if len(specs) != 1 || specs[0].Ref != "npm:weather-mcp" {
		t.Fatalf("expected inner npx spec, got %+v", specs)
	}
}

func TestWrappedTargetWithoutDashDashUnwraps(t *testing.T) {
	// The proxy accepts the launcher without `--` too; the unwrap must find
	// the first non-flag token.
	specs := ParseInstalls("claude mcp add w -- pkgxray mcp-proxy npx weather-mcp")
	if len(specs) != 1 || specs[0].Ref != "npm:weather-mcp" {
		t.Fatalf("expected inner npx spec, got %+v", specs)
	}
}

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"plain":       "plain",
		"has space":   "'has space'",
		"it's":        `'it'\''s'`,
		"a&&b":        "'a&&b'",
		"":            "''",
		"npm:x@1.0.0": "npm:x@1.0.0",
	}
	for in, want := range cases {
		if got := shellQuote(in); got != want {
			t.Fatalf("shellQuote(%q) = %q, want %q", in, got, want)
		}
	}
}
