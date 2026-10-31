//go:build !windows

package claim

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const (
	// appliesHostname: the claim hostname becomes the system hostname.
	appliesHostname = true
	// secretEnvMemoryOnly forces Options.SecretEnvInMemory; on Linux the
	// env is kept in the tmpfs.
	secretEnvMemoryOnly = false
)

// validLinkPath reports whether a link_path is an absolute path without
// ".." elements other than "/".
func validLinkPath(lp string) bool {
	return strings.HasPrefix(lp, "/") && !slices.Contains(strings.Split(lp, "/"), "..") && filepath.Clean(lp) != "/"
}

// removeSecretFile deletes a secret file from the tmpfs; there is nothing
// to overwrite in RAM.
func removeSecretFile(path string) error {
	return os.RemoveAll(path)
}

// secureDir sets mode on a secrets directory and, with group, the default
// user's group.
func (m *Manager) secureDir(path string, mode fs.FileMode, group bool) error {
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("claim: %w", err)
	}
	if group {
		return m.chownGroup(path)
	}
	return nil
}

// writeGroupFile writes a tmpfs file with mode and the default user's
// group.
func (m *Manager) writeGroupFile(path string, data []byte, mode fs.FileMode) error {
	if err := m.writeFile(path, data, mode); err != nil {
		return internal("write secret", err)
	}
	return m.chownGroup(path)
}

// chownGroup gives path the default user's group; the owner is unchanged
// (root in production). Without a known user it does nothing.
func (m *Manager) chownGroup(path string) error {
	m.mu.RLock()
	u := m.user
	m.mu.RUnlock()
	if u == nil {
		return nil
	}
	if err := os.Lchown(path, -1, int(u.GID)); err != nil {
		return internal("chown secret", err)
	}
	return nil
}

// mkdirAllOwned creates dir and its missing parents (0755, root). Created
// directories inside the default user's home (after resolving symlinks, so
// a symlink in the home cannot hand out directories elsewhere) are given to
// the user; the others stay root-owned.
func (m *Manager) mkdirAllOwned(dir string) error {
	var missing []string
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Lstat(d); err == nil {
			break
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		missing = append(missing, d)
		if filepath.Dir(d) == d {
			break
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	m.mu.RLock()
	u := m.user
	m.mu.RUnlock()
	if u == nil || u.Home == "" || len(missing) == 0 {
		return nil
	}
	home, err := m.l.Rooted(u.Home)
	if err != nil {
		return nil
	}
	if home, err = filepath.EvalSymlinks(home); err != nil {
		return nil
	}
	for _, d := range missing {
		resolved, err := filepath.EvalSymlinks(d)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(resolved, home+string(filepath.Separator)) {
			continue
		}
		if err := os.Lchown(resolved, int(u.UID), int(u.GID)); err != nil {
			return fmt.Errorf("chown %s: %w", d, err)
		}
	}
	return nil
}
