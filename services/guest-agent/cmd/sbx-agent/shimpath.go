package main

import (
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// versionShimPath returns the binary the agent starts as the shim: exe
// with the current link resolved, so a shim runs from the directory of its
// version (S9 spec 12.6) and keeps that directory, not current, in use
// across updates. A binary outside the versions directory (a dev run) or
// one that cannot be resolved stays exe.
func versionShimPath(l paths.Layout, exe string, resolve func(string) (string, error)) string {
	resolved, err := resolve(exe)
	if err != nil {
		slog.Warn("agent: cannot resolve the agent binary, shims start from its path", "path", exe, "err", err)
		return exe
	}
	versions, err := resolve(l.VersionsDir)
	if err != nil {
		versions = l.VersionsDir
	}
	if !within(versions, resolved) {
		return exe
	}
	return resolved
}

// within reports whether path lies under dir, ignoring case like NTFS.
func within(dir, path string) bool {
	rel, err := filepath.Rel(strings.ToLower(filepath.Clean(dir)), strings.ToLower(filepath.Clean(path)))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
