// Package fsutil holds crash-safe file helpers.
package fsutil

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

// WriteFileAtomic writes data to path through a temporary file in the same
// directory: write, fsync, rename, fsync of the directory. A reader sees either
// the old or the new content. perm is applied exactly, regardless of umask.
func WriteFileAtomic(path string, data []byte, perm fs.FileMode) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	if err = tmp.Chmod(perm); err != nil {
		return err
	}
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	return syncDir(dir)
}

// syncDir fsyncs a directory so a rename into it survives a crash. Windows
// cannot sync directories; there it is a no-op.
func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}

// WriteJSONAtomic marshals v and writes it with WriteFileAtomic.
func WriteJSONAtomic(path string, v any, perm fs.FileMode) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("fsutil: marshal %s: %w", path, err)
	}
	return WriteFileAtomic(path, data, perm)
}

// ReadJSON reads path and unmarshals it into v. A missing file returns an
// error for which errors.Is(err, fs.ErrNotExist) is true.
func ReadJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("fsutil: parse %s: %w", path, err)
	}
	return nil
}
