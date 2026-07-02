package main

import (
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
)

// dependencyManifests are the files whose edits warrant a re-audit.
var dependencyManifests = map[string]bool{
	"package.json":        true,
	"package-lock.json":   true,
	"yarn.lock":           true,
	"pnpm-lock.yaml":      true,
	"npm-shrinkwrap.json": true,
}

func isDependencyManifest(filePath string) bool {
	return dependencyManifests[filepath.Base(filePath)]
}

// runCLI runs the pkgxray CLI and returns its combined output and exit code.
func runCLI(bin string, args ...string) (string, int) {
	cmd := exec.Command(bin, args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return string(out), exitErr.ExitCode()
	}
	return err.Error(), -1
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}
