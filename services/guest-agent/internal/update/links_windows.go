package update

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// BinaryName is the agent binary in a package and a version directory of
// this OS.
const BinaryName = "umiak-agent.exe"

// pointLink points the junction link (current or previous) at version v
// (S9 spec 12.12). A junction cannot be renamed over another, so the new
// junction is created under a temporary name, the old one is removed and
// the new one renamed into place. A crash in between leaves link at the old
// version (repaired by pending-update.json and the rollback) or missing.
// A missing current is not covered by the service failure actions: the
// image path does not resolve, so no process runs and the rollback command
// (under current or previous) may not exist either. The recovery is the
// boot step `umiak-agent early`, which recreates a missing current from
// pending-update.json or previous (S9 Task 17), or the QEMU guest agent.
func pointLink(l paths.Layout, link, v string) error {
	target, err := filepath.Abs(VersionDir(l, v))
	if err != nil {
		return err
	}
	dir := filepath.Dir(link)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "."+filepath.Base(link)+".tmp-"+randHex())
	if err := createJunction(tmp, target); err != nil {
		return err
	}
	if err := removeJunction(link); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// removeJunction removes the junction (or symlink) at link; a missing link
// is fine. A real directory there is an error: it may hold a version.
func removeJunction(link string) error {
	fi, err := os.Lstat(link)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) == 0 {
		return fmt.Errorf("update: %s is not a junction", link)
	}
	// RemoveDirectory on a junction removes the link, not the target.
	return os.Remove(link)
}

// linkCLI does nothing on Windows: the current junction is on the system
// Path (see addToSystemPath).
func linkCLI(paths.Layout) error { return nil }

// environmentKey holds the machine environment.
const environmentKey = `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`

// addToSystemPath appends dir to the machine Path unless an entry names it
// already (case-insensitive, trailing separators ignored). New processes
// see it; running ones keep their environment.
func addToSystemPath(dir string) error {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, environmentKey, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("update: open machine environment: %w", err)
	}
	defer func() { _ = k.Close() }()
	cur, _, err := k.GetStringValue("Path")
	if err != nil && !errors.Is(err, registry.ErrNotExist) {
		return fmt.Errorf("update: read the system Path: %w", err)
	}
	next, changed := withPathEntry(cur, dir)
	if !changed {
		return nil
	}
	if err := k.SetExpandStringValue("Path", next); err != nil {
		return fmt.Errorf("update: write the system Path: %w", err)
	}
	return nil
}

// withPathEntry returns path with dir appended, and whether it changed.
func withPathEntry(path, dir string) (string, bool) {
	norm := func(s string) string { return strings.ToLower(strings.TrimRight(strings.TrimSpace(s), `\/`)) }
	for _, e := range strings.Split(path, ";") {
		if norm(e) == norm(dir) {
			return path, false
		}
	}
	if path == "" || strings.HasSuffix(path, ";") {
		return path + dir, true
	}
	return path + ";" + dir, true
}
