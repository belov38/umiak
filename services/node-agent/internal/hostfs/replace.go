// Package hostfs rewrites host files the way Proxmox does for its own config files.
package hostfs

import (
	"bytes"
	"io"
	"os"
	"syscall"
)

// ReplaceLocked takes an exclusive flock on path (as PVE::Tools::lock_file does), passes the
// current content to edit and atomically replaces the file if the content changed.
func ReplaceLocked(path string, edit func([]byte) ([]byte, error)) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0) //nolint:gosec // path comes from the node config
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil { //nolint:gosec // fd fits in int
		return err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return err
	}
	out, err := edit(data)
	if err != nil || bytes.Equal(out, data) {
		return err
	}
	tmp := path + ".sbx-tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil { //nolint:gosec // dnsmasq reads it as non-root
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil { //nolint:gosec // same as above
		return err
	}
	return os.Rename(tmp, path)
}
