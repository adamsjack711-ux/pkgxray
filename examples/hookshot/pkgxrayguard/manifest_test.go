package pkgxrayguard

import (
	"reflect"
	"sort"
	"testing"
)

func specRefs(specs []InstallSpec) []string {
	out := make([]string, 0, len(specs))
	for _, s := range specs {
		out = append(out, s.Ref)
	}
	sort.Strings(out)
	return out
}

func TestManifestAddedSpecs(t *testing.T) {
	cases := []struct {
		name string
		edit FileEdit
		want []string
	}{
		{
			"added registry dep with exact version",
			FileEdit{
				OldString: `  "dependencies": {`,
				NewString: `  "dependencies": {` + "\n" + `    "left-pad": "1.3.0",`,
			},
			[]string{"npm:left-pad@1.3.0"},
		},
		{
			"added dep with a range keeps no version",
			FileEdit{OldString: ``, NewString: `    "express": "^4.18.0"`},
			[]string{"npm:express"},
		},
		{
			"scoped dep",
			FileEdit{OldString: ``, NewString: `    "@types/node": "^20.1.0"`},
			[]string{"npm:@types/node"},
		},
		{
			"git dep is a review-worthy vcs spec, not npm:name",
			FileEdit{OldString: ``, NewString: `    "evil": "git+https://github.com/x/y.git"`},
			[]string{"git+https://github.com/x/y.git"},
		},
		{
			"version bump counts as changed",
			FileEdit{
				OldString: `    "lodash": "4.17.20"`,
				NewString: `    "lodash": "4.17.21"`,
			},
			[]string{"npm:lodash@4.17.21"},
		},
		{
			"unchanged dep in the hunk is ignored",
			FileEdit{
				OldString: `    "lodash": "4.17.21",` + "\n" + `    "react": "18.2.0"`,
				NewString: `    "lodash": "4.17.21",` + "\n" + `    "react": "18.2.0",` + "\n" + `    "zod": "3.22.0"`,
			},
			[]string{"npm:zod@3.22.0"},
		},
		{
			"non-dependency fields are not treated as packages",
			FileEdit{
				OldString: ``,
				NewString: `  "name": "my-app",` + "\n" + `  "version": "1.0.0",` + "\n" + `  "description": "a tool",` + "\n" + `  "license": "MIT",` + "\n" + `  "main": "index.js"`,
			},
			nil,
		},
		{
			"local file: dep is skipped",
			FileEdit{OldString: ``, NewString: `    "sibling": "file:../sibling"`},
			nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := specRefs(ManifestAddedSpecs([]FileEdit{tc.edit}))
			want := tc.want
			sort.Strings(want)
			if len(got) == 0 && len(want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("ManifestAddedSpecs = %v, want %v", got, want)
			}
		})
	}
}

func TestManifestAddedSpecsKindAndImmediate(t *testing.T) {
	specs := ManifestAddedSpecs([]FileEdit{{NewString: `"evil": "git+https://github.com/x/y.git", "ok": "1.2.3"`}})
	byRef := map[string]InstallSpec{}
	for _, s := range specs {
		byRef[s.Ref] = s
	}
	if byRef["git+https://github.com/x/y.git"].Kind != KindVCS {
		t.Errorf("git dep should be KindVCS, got %q", byRef["git+https://github.com/x/y.git"].Kind)
	}
	if byRef["npm:ok@1.2.3"].Kind != KindRegistry {
		t.Errorf("registry dep should be KindRegistry, got %q", byRef["npm:ok@1.2.3"].Kind)
	}
	// Manifest deps are persistent installs, never execute-immediately.
	for _, s := range specs {
		if s.Immediate {
			t.Errorf("%s should not be Immediate", s.Ref)
		}
	}
}
