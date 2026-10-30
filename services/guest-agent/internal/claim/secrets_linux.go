package claim

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// tmpfsFlags are the mount flags of the secrets tmpfs.
const tmpfsFlags = unix.MS_NOSUID | unix.MS_NODEV

// mountSecrets mounts a tmpfs at dir unless one is mounted there already
// (Decision 6): "noswap,mode=0755", or without noswap with a warning when the
// kernel refuses it (before 6.4).
func mountSecrets(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	mounted, err := isMountPoint(dir)
	if err != nil {
		return err
	}
	if mounted {
		var st unix.Statfs_t
		if err := unix.Statfs(dir, &st); err != nil {
			return fmt.Errorf("statfs %s: %w", dir, err)
		}
		if st.Type != unix.TMPFS_MAGIC {
			return fmt.Errorf("%s is a mount point but not a tmpfs", dir)
		}
		return nil
	}
	err = unix.Mount("tmpfs", dir, "tmpfs", tmpfsFlags, "noswap,mode=0755")
	if errors.Is(err, unix.EINVAL) {
		slog.Warn("kernel rejects tmpfs noswap, mounting secrets without it", "dir", dir)
		err = unix.Mount("tmpfs", dir, "tmpfs", tmpfsFlags, "mode=0755")
	}
	if err != nil {
		return fmt.Errorf("mount tmpfs at %s: %w", dir, err)
	}
	return nil
}

// isMountPoint reports whether dir is on another device than its parent.
func isMountPoint(dir string) (bool, error) {
	var st, parent unix.Stat_t
	if err := unix.Stat(dir, &st); err != nil {
		return false, fmt.Errorf("stat %s: %w", dir, err)
	}
	if err := unix.Stat(filepath.Dir(dir), &parent); err != nil {
		return false, fmt.Errorf("stat %s: %w", filepath.Dir(dir), err)
	}
	return st.Dev != parent.Dev, nil
}
