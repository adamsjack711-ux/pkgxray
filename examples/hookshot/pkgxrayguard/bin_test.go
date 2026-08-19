package pkgxrayguard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveBinPrefersPath(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, filepath.Join(dir, "pkgxray-test-bin"))
	t.Setenv("PATH", dir)

	got := resolveNamed("pkgxray-test-bin")
	if got != filepath.Join(dir, "pkgxray-test-bin") {
		t.Errorf("resolveNamed = %q, want the PATH hit in %q", got, dir)
	}
}

func TestResolveBinKeepsExplicitPath(t *testing.T) {
	// An explicit path is never second-guessed, even when it does not exist:
	// the caller's own "not found" error is more useful than a substitution.
	for _, p := range []string{"/opt/pkgxray/bin/pkgxray", "./pkgxray", "../bin/pkgxray"} {
		if got := resolveNamed(p); got != p {
			t.Errorf("resolveNamed(%q) = %q, want it unchanged", p, got)
		}
	}
}

func TestResolveBinFallsBackToStandardDirs(t *testing.T) {
	// Simulate the real failure: a working install that PATH cannot see.
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(binDir, "pkgxray-fallback")
	writeExecutable(t, target)

	t.Setenv("PATH", t.TempDir()) // an empty directory: no PATH hit
	t.Setenv("HOME", home)

	saved := standardBinDirs
	standardBinDirs = []string{"~/.local/bin"}
	defer func() { standardBinDirs = saved }()

	if got := resolveNamed("pkgxray-fallback"); got != target {
		t.Errorf("resolveNamed = %q, want the fallback hit %q", got, target)
	}
}

func TestResolveBinReturnsNameWhenNothingFound(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	saved := standardBinDirs
	standardBinDirs = []string{t.TempDir()}
	defer func() { standardBinDirs = saved }()

	if got := resolveNamed("pkgxray-absent"); got != "pkgxray-absent" {
		t.Errorf("resolveNamed = %q, want the name unchanged so the caller reports not-found", got)
	}
}

func TestResolveBinSkipsDirectoriesAndNonExecutables(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "pkgxray-dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pkgxray-plain"), []byte("not executable"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	saved := standardBinDirs
	standardBinDirs = []string{dir}
	defer func() { standardBinDirs = saved }()

	for _, name := range []string{"pkgxray-dir", "pkgxray-plain"} {
		if got := resolveNamed(name); got != name {
			t.Errorf("resolveNamed(%q) = %q, want it rejected", name, got)
		}
	}
}

func TestResolveBinDefaultsEmptyName(t *testing.T) {
	if got := ResolveBin(""); got == "" {
		t.Error(`ResolveBin("") returned empty, want it to default to pkgxray`)
	}
}

func TestExpandHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if got, want := expandHome("~/.local/bin"), filepath.Join(home, ".local/bin"); got != want {
		t.Errorf("expandHome = %q, want %q", got, want)
	}
	for _, p := range []string{"/usr/local/bin", "~notauser/bin", "~"} {
		if got := expandHome(p); got != p {
			t.Errorf("expandHome(%q) = %q, want it unchanged", p, got)
		}
	}
}

func writeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestChildEnvAppendsStandardDirs(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", "/usr/bin:/bin")

	saved := standardBinDirs
	standardBinDirs = []string{"~/.local/bin", filepath.Join(home, "does-not-exist")}
	defer func() { standardBinDirs = saved }()

	path := pathFromEnv(t, ChildEnv())
	dirs := filepath.SplitList(path)
	if len(dirs) < 3 || dirs[0] != "/usr/bin" || dirs[1] != "/bin" {
		t.Fatalf("PATH = %q, want the original entries first", path)
	}
	if dirs[len(dirs)-1] != binDir {
		t.Errorf("PATH = %q, want %q appended", path, binDir)
	}
	for _, d := range dirs {
		if strings.Contains(d, "does-not-exist") {
			t.Errorf("PATH = %q, want nonexistent dirs skipped", path)
		}
	}
}

func TestChildEnvDoesNotDuplicateOrReorder(t *testing.T) {
	t.Setenv("PATH", "/opt/homebrew/bin:/usr/bin")
	saved := standardBinDirs
	standardBinDirs = []string{"/usr/bin", "/opt/homebrew/bin"}
	defer func() { standardBinDirs = saved }()

	dirs := filepath.SplitList(pathFromEnv(t, ChildEnv()))
	if len(dirs) != 2 || dirs[0] != "/opt/homebrew/bin" || dirs[1] != "/usr/bin" {
		t.Errorf("PATH entries = %v, want the original two in their original order", dirs)
	}
}

func TestChildEnvSuppliesPathWhenUnset(t *testing.T) {
	t.Setenv("PATH", "")
	saved := standardBinDirs
	standardBinDirs = []string{"/usr/bin"}
	defer func() { standardBinDirs = saved }()

	if got := pathFromEnv(t, ChildEnv()); got != "/usr/bin" {
		t.Errorf("PATH = %q, want the standard dirs to stand in", got)
	}
}

func TestChildEnvCarriesExtras(t *testing.T) {
	env := ChildEnv("PKGXRAY_CACHE_URL=http://localhost:1234")
	var found bool
	for _, kv := range env {
		if kv == "PKGXRAY_CACHE_URL=http://localhost:1234" {
			found = true
		}
	}
	if !found {
		t.Error("ChildEnv dropped the extra entry")
	}
}

func pathFromEnv(t *testing.T, env []string) string {
	t.Helper()
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			return strings.TrimPrefix(kv, "PATH=")
		}
	}
	t.Fatal("ChildEnv returned no PATH entry")
	return ""
}
