//go:build !linux

package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// errNotDir is the errno of a non-directory in the way.
var errNotDir error = syscall.ENOTDIR

// rootDir is the extractDir of other systems: an os.Root (which refuses
// paths that leave the directory) plus an Lstat of every parent component
// that refuses symlinks inside it too. Unlike openat2 the check and the use
// are separate calls, so a concurrent swap of a component is caught only by
// os.Root's own confinement.
type rootDir struct {
	r *os.Root
}

// openExtractDir opens dir for a confined unpack.
func openExtractDir(dir string) (extractDir, error) {
	r, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &rootDir{r: r}, nil
}

// confined maps an os.Root error: leaving the root is invalid_path.
func confined(rel string, err error) error {
	if err != nil && strings.Contains(err.Error(), "path escapes from parent") {
		return errInvalidPath("%s: the path leaves the directory", rel)
	}
	return err
}

// checkParents refuses rel when one of its parent components is a symlink.
// Missing components are fine.
func (d *rootDir) checkParents(rel string) error {
	elems := strings.Split(rel, "/")
	for i := 1; i < len(elems); i++ {
		p := filepath.FromSlash(strings.Join(elems[:i], "/"))
		fi, err := d.r.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return confined(rel, err)
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return errInvalidPath("%s: the path passes through a symlink", rel)
		}
	}
	return nil
}

// MkdirAll implements extractDir.
func (d *rootDir) MkdirAll(rel string, perm fs.FileMode, o owner) error {
	elems := strings.Split(rel, "/")
	for i := 1; i <= len(elems); i++ {
		p := filepath.FromSlash(strings.Join(elems[:i], "/"))
		fi, err := d.r.Lstat(p)
		switch {
		case err == nil && fi.Mode()&fs.ModeSymlink != 0:
			return errInvalidPath("%s: the path passes through a symlink", rel)
		case err == nil && !fi.IsDir():
			return &fs.PathError{Op: "mkdir", Path: rel, Err: errNotDir}
		case err == nil:
			continue
		case !errors.Is(err, fs.ErrNotExist):
			return confined(rel, err)
		}
		if err := d.r.Mkdir(p, perm); err != nil && !errors.Is(err, fs.ErrExist) {
			return confined(rel, err)
		}
		if err := d.r.Chmod(p, perm); err != nil {
			return confined(rel, err)
		}
		if err := rootLchown(d.r, p, o); err != nil {
			return confined(rel, err)
		}
	}
	return nil
}

// Lstat implements extractDir.
func (d *rootDir) Lstat(rel string) (fs.FileMode, error) {
	if err := d.checkParents(rel); err != nil {
		return 0, err
	}
	fi, err := d.r.Lstat(filepath.FromSlash(rel))
	if err != nil {
		return 0, confined(rel, err)
	}
	return fi.Mode().Type(), nil
}

// Mkdir implements extractDir.
func (d *rootDir) Mkdir(rel string, perm fs.FileMode) error {
	if err := d.checkParents(rel); err != nil {
		return err
	}
	return confined(rel, d.r.Mkdir(filepath.FromSlash(rel), perm))
}

// Create implements extractDir.
func (d *rootDir) Create(rel string, perm fs.FileMode) (*os.File, error) {
	if err := d.checkParents(rel); err != nil {
		return nil, err
	}
	f, err := d.r.OpenFile(filepath.FromSlash(rel), os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	return f, confined(rel, err)
}

// Symlink implements extractDir.
func (d *rootDir) Symlink(target, rel string) error {
	if err := d.checkParents(rel); err != nil {
		return err
	}
	return confined(rel, d.r.Symlink(target, filepath.FromSlash(rel)))
}

// Link implements extractDir.
func (d *rootDir) Link(oldRel, newRel string) error {
	if err := d.checkParents(oldRel); err != nil {
		return err
	}
	if err := d.checkParents(newRel); err != nil {
		return err
	}
	return confined(newRel, d.r.Link(filepath.FromSlash(oldRel), filepath.FromSlash(newRel)))
}

// Remove implements extractDir.
func (d *rootDir) Remove(rel string) error {
	if err := d.checkParents(rel); err != nil {
		return err
	}
	return confined(rel, d.r.Remove(filepath.FromSlash(rel)))
}

// Lchown implements extractDir.
func (d *rootDir) Lchown(rel string, o owner) error {
	if err := d.checkParents(rel); err != nil {
		return err
	}
	return confined(rel, rootLchown(d.r, filepath.FromSlash(rel), o))
}

// ChmodDir implements extractDir.
func (d *rootDir) ChmodDir(rel string, mode uint32) error {
	typ, err := d.Lstat(rel)
	if err != nil {
		return err
	}
	if !typ.IsDir() {
		return &fs.PathError{Op: "chmod", Path: rel, Err: errNotDir}
	}
	return confined(rel, d.r.Chmod(filepath.FromSlash(rel), toFileMode(mode)))
}

// Chtimes implements extractDir. os.Root follows a final symlink, so the
// mtime of a symlink is left alone here.
func (d *rootDir) Chtimes(rel string, mtime time.Time) error {
	typ, err := d.Lstat(rel)
	if err != nil {
		return err
	}
	if typ&fs.ModeSymlink != 0 {
		return nil
	}
	return confined(rel, d.r.Chtimes(filepath.FromSlash(rel), mtime, mtime))
}

// Close implements extractDir.
func (d *rootDir) Close() error {
	return d.r.Close()
}
