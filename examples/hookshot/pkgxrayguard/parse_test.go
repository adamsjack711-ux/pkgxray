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
