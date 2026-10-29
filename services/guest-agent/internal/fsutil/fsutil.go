// Package fsutil holds crash-safe file helpers.
package fsutil

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
)

// rename is os.Rename; tests replace it.
var rename = os.Rename

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
	if err = rename(tmp.Name(), path); err != nil {
		return err
	}
	return syncDir(dir)
}

// ReplaceFile is WriteFileAtomic for files that may be mount points: when the
// rename fails with EBUSY (a file bind-mounted over the target, like the
// /etc/hostname and /etc/hosts of a container), it rewrites the existing file
// in place and keeps its mode: the new content is written over the old one
// from offset 0, then the file is cut to the new length and synced. A reader
// never sees an empty file unless the content shrinks to nothing, but may see
// the new head on the old tail; a crash in between can leave that mix.
func ReplaceFile(path string, data []byte, perm fs.FileMode) error {
	err := WriteFileAtomic(path, data, perm)
	if !errors.Is(err, syscall.EBUSY) {
		return err
	}
	f, oerr := os.OpenFile(path, os.O_WRONLY, 0)
	if oerr != nil {
		return errors.Join(err, oerr)
	}
	_, werr := f.WriteAt(data, 0)
	if werr == nil {
		werr = f.Truncate(int64(len(data)))
	}
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return fmt.Errorf("fsutil: rewrite %s in place: %w", path, werr)
	}
	return nil
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
