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
)

// ReplaceLocked takes an exclusive flock on path (as PVE::Tools::lock_file does), passes the
// current content to edit and atomically replaces the file if the content changed.
//
// Writers replace the file by rename, so a waiter may get the lock on an inode that is no longer
// at path; it then retries on the current file instead of overwriting a newer version.
func ReplaceLocked(path string, edit func([]byte) ([]byte, error)) error {
	for {
		done, err := replaceOnce(path, edit)
		if done || err != nil {
			return err
		}
	}
}

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
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".sbx-"+hex.EncodeToString(suffix))
	if err := writeSynced(tmp, out); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return false, err
	}
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
