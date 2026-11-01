// Package hostfs rewrites host files the way Proxmox does for its own config files.
package hostfs

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// ReplaceLocked takes an exclusive flock on path (as PVE::Tools::lock_file does), passes the
// current content to edit and atomically replaces the file if the content changed.
//
// Writers replace the file by rename, so a waiter may get the lock on an inode that is no longer
// at path; it then retries on the current file instead of overwriting a newer version.
//
// Proxmox (PVE::Tools::lock_file on the ethers file itself, no separate lock file) has the same
// stale-inode problem and does not check for it: a Proxmox writer that waited for the lock may hold
// it on an old inode while we hold it on the current one. Such a writer reads the file by path,
// writes ethers.tmp and renames it over the file; that read-and-write takes a few ms and overlaps
// ours in both directions:
//   - its rename lands after ours, based on content read before ours: our change is lost. We
//     check right before our rename that the path is still the locked inode, and after our rename
//     wait settleDelay and check that our change is still there; otherwise the edit runs again.
//     A Proxmox rename later than settleDelay still loses our change; delete verification then
//     sees the leftover line and releases again.
//   - its rename lands between our inode check and our rename: its change is lost, and we cannot
//     see that. Proxmox writes ethers on VM start, so a start racing a delete may lose its static
//     mapping (and two concurrent Proxmox starts have the same problem among themselves). S6
//     serializes starts and deletes per node (spec §12).
func ReplaceLocked(path string, edit func([]byte) ([]byte, error)) error {
	for {
		done, err := replaceOnce(path, edit)
		if err != nil || !done {
			if err != nil {
				return err
			}
			continue
		}
		time.Sleep(settleDelay)
		ok, err := applied(path, edit)
		if err != nil || ok {
			return err
		}
	}
}

// settleDelay covers a concurrent Proxmox read-modify-rename of the ethers file.
const settleDelay = 50 * time.Millisecond

// applied reports whether path already has edit's change.
func applied(path string, edit func([]byte) ([]byte, error)) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // path comes from the node config
	if err != nil {
		return false, err
	}
	out, err := edit(data)
	return err == nil && bytes.Equal(out, data), err
}

// afterRename runs right after our rename; tests use it to inject a concurrent writer.
var afterRename = func() {}

func replaceOnce(path string, edit func([]byte) ([]byte, error)) (bool, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0) //nolint:gosec // path comes from the node config
	if err != nil {
		return false, err
	}
	defer func() { _ = f.Close() }()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil { //nolint:gosec // fd fits in int
		return false, err
	}
	locked, err := f.Stat()
	if err != nil {
		return false, err
	}
	current, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	if !os.SameFile(locked, current) {
		return false, nil
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return false, err
	}
	out, err := edit(data)
	if err != nil || bytes.Equal(out, data) {
		return true, err
	}
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".umiak-"+hex.EncodeToString(suffix))
	if err := writeSynced(tmp, out); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	if current, err = os.Stat(path); err != nil || !os.SameFile(locked, current) {
		_ = os.Remove(tmp)
		return false, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	afterRename()
	return true, nil
}

func writeSynced(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644) //nolint:gosec // dnsmasq reads it as non-root
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Chmod(0o644); err != nil { //nolint:gosec // same as above
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
