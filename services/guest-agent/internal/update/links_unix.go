//go:build !windows

package update

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// BinaryName is the agent binary in a package and a version directory of
// this OS.
const BinaryName = "umiak-agent"

// pointLink points link (current or previous) at version v. The target is
// relative, so the tree stays valid under any root.
func pointLink(l paths.Layout, link, v string) error {
	target, err := filepath.Rel(filepath.Dir(link), VersionDir(l, v))
	if err != nil {
		return err
	}
	return switchLink(link, target)
}

// switchLink atomically replaces link with a symlink to target: a new
// symlink under a temporary name is renamed over the old one.
func switchLink(link, target string) error {
	dir := filepath.Dir(link)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "."+filepath.Base(link)+".tmp-"+randHex())
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncDir(dir)
}

// linkCLI makes /usr/local/bin/umiak-agent a symlink to current/umiak-agent.
func linkCLI(l paths.Layout) error {
	target, err := filepath.Rel(filepath.Dir(l.BinLink), filepath.Join(l.CurrentLink, BinaryName))
	if err == nil {
		err = switchLink(l.BinLink, target)
	}
	if err != nil {
		return fmt.Errorf("update: link %s: %w", l.BinLink, err)
	}
	return nil
}
