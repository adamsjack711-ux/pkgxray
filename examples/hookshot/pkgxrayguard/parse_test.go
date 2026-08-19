package pkgxrayguard

import (
	"reflect"
	"testing"
)

func refs(specs []InstallSpec) []string {
	out := make([]string, 0, len(specs))
	for _, s := range specs {
		out = append(out, s.Ref)
	}
	return out
}

func TestParseInstalls(t *testing.T) {
	cases := []struct {
		name string
		cmd  string
		want []string
	}{
		{"npm install one", "npm install express", []string{"npm:express"}},
		{"npm i short", "npm i react@18.2.0", []string{"npm:react@18.2.0"}},
		{"npm install many + flag", "npm install --save-dev jest lodash", []string{"npm:jest", "npm:lodash"}},
		{"scoped package", "npm install @types/node", []string{"npm:@types/node"}},
		{"scoped with version", "pnpm add @scope/pkg@1.2.3", []string{"npm:@scope/pkg@1.2.3"}},
		{"yarn add", "yarn add left-pad", []string{"npm:left-pad"}},
		{"yarn global add", "yarn global add typescript", []string{"npm:typescript"}},
		{"bun add", "bun add zod", []string{"npm:zod"}},
		{"npx runner", "npx create-react-app my-app", []string{"npm:create-react-app"}},
		{"npx -y flag", "npx -y cowsay hello", []string{"npm:cowsay"}},
		{"npx --package", "npx --package=typescript tsc", []string{"npm:typescript"}},
		{"npx -p value", "npx -p esbuild esbuild --version", []string{"npm:esbuild"}},
		{"pnpm dlx", "pnpm dlx prettier --write .", []string{"npm:prettier"}},
		{"chained &&", "npm ci && npm install evil-pkg", []string{"npm:evil-pkg"}},
		{"claude mcp add launcher", "claude mcp add weather -- npx -y @acme/weather-mcp", []string{"npm:@acme/weather-mcp"}},
		{"quoted spec", "npm install \"lodash@4.17.21\"", []string{"npm:lodash@4.17.21"}},

		// Git/tarball/URL specs are unvettable by registry triage but must be
		// surfaced (as review-worthy) rather than silently dropped.
		{"git+https spec", "npm install git+https://github.com/x/y.git", []string{"git+https://github.com/x/y.git"}},
		{"git@ ssh spec", "npm i git@github.com:x/y.git", []string{"git@github.com:x/y.git"}},
		{"remote tarball url", "npm i https://example.com/pkg.tgz", []string{"https://example.com/pkg.tgz"}},
		{"npx of a git url", "npx git+https://github.com/x/y.git", []string{"git+https://github.com/x/y.git"}},

		// Non-installs and local targets → nothing (already-visible code).
		{"bare npm install", "npm install", nil},
		{"npm ci", "npm ci", nil},
		{"npm run build", "npm run build", nil},
		{"local path", "npm install ./local-tarball.tgz", nil},
		{"file protocol", "npm install file:../sibling", nil},
		{"unrelated command", "rm -rf node_modules", nil},
		{"echo", "echo npm install nope", nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := refs(ParseInstalls(tc.cmd))
			if len(got) == 0 && len(tc.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ParseInstalls(%q) = %v, want %v", tc.cmd, got, tc.want)
			}
		})
	}
}

func TestParseInstallsKindAndImmediate(t *testing.T) {
	cases := []struct {
		name         string
		cmd          string
		wantKind     SpecKind
		wantImmediat bool
	}{
		{"registry install is not immediate", "npm install express", KindRegistry, false},
		{"registry runner is immediate", "npx create-react-app app", KindRegistry, true},
		{"pnpm dlx is immediate", "pnpm dlx prettier", KindRegistry, true},
		{"git install is vcs, not immediate", "npm i git+https://github.com/x/y.git", KindVCS, false},
		{"git runner is vcs and immediate", "npx git+https://github.com/x/y.git", KindVCS, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			specs := ParseInstalls(tc.cmd)
			if len(specs) != 1 {
				t.Fatalf("ParseInstalls(%q) = %d specs, want 1", tc.cmd, len(specs))
			}
			if specs[0].Kind != tc.wantKind {
				t.Errorf("Kind = %q, want %q", specs[0].Kind, tc.wantKind)
			}
			if specs[0].Immediate != tc.wantImmediat {
				t.Errorf("Immediate = %v, want %v", specs[0].Immediate, tc.wantImmediat)
			}
		})
	}
}

func TestParseInstallsDedupes(t *testing.T) {
	got := refs(ParseInstalls("npm install express && npm install express@4"))
	want := []string{"npm:express", "npm:express@4"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// Shell redirections are plumbing, not arguments. Before they were understood,
// the redirect and its target were parsed as package names, so an ordinary
// install that merely piped its output was denied for a package that does not
// exist — "2>&1" being the one that turned up in practice.
func TestRedirectionsAreNotPackages(t *testing.T) {
	cases := []struct {
		name string
		cmd  string
		want []string
	}{
		// The forms that denied real installs.
		{"stderr merge after local path", "npm install -g ./pkg.tgz 2>&1", []string{}},
		{"stderr to devnull", "npm install -g ./pkg.tgz 2>/dev/null", []string{}},
		{"stderr merge, piped", "npm install -g ./pkg.tgz 2>&1 | tail -3", []string{}},
		// A redirect after a named package leaves only the package. The spaced
		// form is the dangerous one: "out.txt" reads as a plausible name.
		{"spaced redirect", "npm i express > out.txt", []string{"npm:express"}},
		{"attached redirect", "npm i express >out.txt", []string{"npm:express"}},
		{"append redirect", "npm i express >> log.txt", []string{"npm:express"}},
		{"fd redirect", "npm i express 2> err.log", []string{"npm:express"}},
		{"both streams", "npm i express &> all.log", []string{"npm:express"}},
		{"fd duplication", "npm i express 1>&2", []string{"npm:express"}},
		{"stdin redirect", "npm i express < input.txt", []string{"npm:express"}},
		// A trailing & backgrounds the command; it is not a package.
		{"backgrounded", "npm i express &", []string{"npm:express"}},
		{"background separates commands", "npm i express & npm i lodash", []string{"npm:express", "npm:lodash"}},
		// Redirects survive chaining, on both sides of the operator.
		{"chained with redirects", "npm i express 2>&1 && pnpm add lodash > /dev/null", []string{"npm:express", "npm:lodash"}},
		// Every manager, not just npm.
		{"yarn", "yarn add left-pad 2>&1", []string{"npm:left-pad"}},
		{"bun", "bun add zod 2>/dev/null", []string{"npm:zod"}},
		{"pnpm dlx", "pnpm dlx prettier --write . > out.log", []string{"npm:prettier"}},
		{"npx", "npx cowsay hi 2>/dev/null", []string{"npm:cowsay"}},
		// A quoted spec containing > is still one token, not a redirect.
		{"quoted range", `npm i "lodash@>=4"`, []string{"npm:lodash@>=4"}},
		// The MCP-add path shares the token list, so it must stay intact too.
		{"mcp add launcher with redirect", "claude mcp add weather -- npx -y @acme/weather-mcp 2>&1", []string{"npm:@acme/weather-mcp"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := refs(ParseInstalls(tc.cmd)); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ParseInstalls(%q) = %v, want %v", tc.cmd, got, tc.want)
			}
		})
	}
}

// Flags whose value is a separate token must not have that value read as a
// package — and a real package named after such a flag must still be caught.
func TestSeparateFlagValuesAreNotPackages(t *testing.T) {
	cases := []struct {
		name string
		cmd  string
		want []string
	}{
		{"npm tag", "npm i --tag latest express", []string{"npm:express"}},
		{"npm workspace short", "npm i -w api express", []string{"npm:express"}},
		{"npm workspace long", "npm i --workspace api express", []string{"npm:express"}},
		{"npm omit", "npm i --omit dev express", []string{"npm:express"}},
		{"npm prefix", "npm install --prefix /tmp/foo express", []string{"npm:express"}},
		{"pnpm filter", "pnpm add --filter web lodash", []string{"npm:lodash"}},
		{"pnpm store-dir", "pnpm add --store-dir /tmp/store lodash", []string{"npm:lodash"}},
		{"registry value", "npm i --registry https://r.example.com express", []string{"npm:express"}},
		{"runner registry value", "npx --registry https://r.example.com cowsay", []string{"npm:cowsay"}},
		// --flag=value keeps working; only the separate-token form is new.
		{"equals form", "npm i --tag=latest express", []string{"npm:express"}},
		// Boolean flags must NOT swallow the token after them.
		{"global short", "npm i -g express", []string{"npm:express"}},
		{"save-dev", "npm install --save-dev typescript", []string{"npm:typescript"}},
		{"npx yes", "npx -y cowsay hello", []string{"npm:cowsay"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := refs(ParseInstalls(tc.cmd)); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ParseInstalls(%q) = %v, want %v", tc.cmd, got, tc.want)
			}
		})
	}
}

// A here-document body is data the command reads on stdin, not a command the
// shell runs. Parsing it meant that writing a README, a CI config, or a test
// fixture that merely quoted an install command tripped the gate on whatever
// the quoted text contained.
func TestHeredocBodiesAreNotCommands(t *testing.T) {
	cases := []struct {
		name string
		cmd  string
		want []string
	}{
		{"quoted delimiter", "cat > doc.md <<'EOF'\nnpm install some-hallucinated-pkg\nEOF", []string{}},
		{"bare delimiter", "cat > doc.md <<EOF\nnpm i another-fake-pkg\nEOF", []string{}},
		{"leading-tab form", "cat > doc.md <<-EOF\n\tyarn add indented-fake\n\tEOF", []string{}},
		{"custom delimiter word", "cat > x.md <<'PY'\npnpm add fake-in-docs\nPY", []string{}},
		{"real install after body", "cat > doc.md <<'EOF'\nnpm i fake-in-docs\nEOF\nnpm i express", []string{"npm:express"}},
		{"real install before body", "npm i express\ncat > doc.md <<'EOF'\nnpm i fake-in-docs\nEOF", []string{"npm:express"}},
		{"unterminated body runs to end", "cat <<EOF\nnpm i fake-in-docs", []string{}},
		{"here-string is one line", "cat <<< hello\nnpm i express", []string{"npm:express"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := refs(ParseInstalls(tc.cmd)); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ParseInstalls(%q) = %v, want %v", tc.cmd, got, tc.want)
			}
		})
	}
}

// heredocDelimiter must not panic or claim a delimiter on malformed input.
func TestHeredocDelimiterEdgeCases(t *testing.T) {
	for _, line := range []string{"cat <<", "cat << |", "cat <<<", "x=$((1 << 2))", "cat <<'unterminated"} {
		if d, ok := heredocDelimiter(line); ok && d == "" {
			t.Errorf("heredocDelimiter(%q) reported an empty delimiter", line)
		}
	}
	if d, ok := heredocDelimiter("cat <<'EOF'"); !ok || d != "EOF" {
		t.Errorf(`heredocDelimiter("cat <<'EOF'") = (%q,%v), want ("EOF",true)`, d, ok)
	}
	if d, ok := heredocDelimiter("cmd <<A <<B"); !ok || d != "B" {
		t.Errorf(`heredocDelimiter("cmd <<A <<B") = (%q,%v), want ("B",true)`, d, ok)
	}
}

// The gate must keep denying what it was built to deny: none of the shell-syntax
// handling above may let a genuine registry install slip past unparsed.
func TestRealInstallsStillParsedAlongsideShellSyntax(t *testing.T) {
	cases := []struct {
		cmd  string
		want []string
	}{
		{"npm i some-package-that-does-not-exist-xyz 2>&1", []string{"npm:some-package-that-does-not-exist-xyz"}},
		{"npm i evil-pkg > /dev/null 2>&1 &", []string{"npm:evil-pkg"}},
		{"cat <<'EOF'\nnot a command\nEOF\nnpm i evil-pkg", []string{"npm:evil-pkg"}},
		{"npm i --tag latest evil-pkg", []string{"npm:evil-pkg"}},
	}
	for _, tc := range cases {
		if got := refs(ParseInstalls(tc.cmd)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("ParseInstalls(%q) = %v, want %v", tc.cmd, got, tc.want)
		}
	}
}
