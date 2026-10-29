package files

import (
	"errors"
	"io/fs"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// resolveFlags confine every lookup to the directory and refuse symlinks in
// any component (Linux 5.6+).
const resolveFlags = unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS

// beneathDir is the Linux extractDir: every path is opened relative to a
// directory fd with openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS) and the
// last component is handled with *at calls that do not follow it.
type beneathDir struct {
	root int
	// One cached parent directory fd: entries of an archive mostly come
	// grouped by directory.
	cacheRel string
	cacheFd  int
}

// openExtractDir opens dir for a confined unpack.
func openExtractDir(dir string) (extractDir, error) {
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: dir, Err: err}
	}
	return &beneathDir{root: fd, cacheFd: -1}, nil
}

// confined maps the errors of a confined lookup: a symlink in the path
// (ELOOP) or an escape (EXDEV) is invalid_path.
func confined(op, rel string, err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, unix.ELOOP), errors.Is(err, unix.EXDEV):
		return errInvalidPath("%s: the path passes through a symlink or leaves the directory", rel)
	default:
		return &fs.PathError{Op: op, Path: rel, Err: err}
	}
}

// openat2 opens rel below dirfd with resolveFlags, retrying EAGAIN (a
// concurrent rename during the lookup).
func openat2(dirfd int, rel string, flags int, mode uint32) (int, error) {
	how := &unix.OpenHow{Flags: uint64(flags | unix.O_CLOEXEC), Mode: uint64(mode), Resolve: resolveFlags}
	for range 8 {
		fd, err := unix.Openat2(dirfd, rel, how)
		if !errors.Is(err, unix.EAGAIN) && !errors.Is(err, unix.EINTR) {
			return fd, err
		}
	}
	return -1, unix.EAGAIN
}

// openDir opens the directory rel ("." is the root itself, not reopened).
func (d *beneathDir) openDir(rel string) (int, error) {
	if rel == "." {
		return unix.Dup(d.root)
	}
	fd, err := openat2(d.root, rel, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	return fd, confined("open", rel, err)
}

// parent returns the fd of the parent of rel and the last component. The
// fd belongs to the cache; callers must not close it.
func (d *beneathDir) parent(rel string) (int, string, error) {
	dir, base := splitRel(rel)
	if dir == "." {
		return d.root, base, nil
	}
	if d.cacheFd >= 0 && d.cacheRel == dir {
		return d.cacheFd, base, nil
	}
	fd, err := d.openDir(dir)
	if err != nil {
		return -1, "", err
	}
	d.dropCache()
	d.cacheRel, d.cacheFd = dir, fd
	return fd, base, nil
}

func (d *beneathDir) dropCache() {
	if d.cacheFd >= 0 {
		_ = unix.Close(d.cacheFd)
		d.cacheFd = -1
	}
}

// splitRel splits a cleaned relative path into its parent and last element.
func splitRel(rel string) (string, string) {
	i := strings.LastIndexByte(rel, '/')
	if i < 0 {
		return ".", rel
	}
	return rel[:i], rel[i+1:]
}

// MkdirAll implements extractDir.
func (d *beneathDir) MkdirAll(rel string, perm fs.FileMode, o owner) error {
	if fd, err := d.openDir(rel); err == nil {
		_ = unix.Close(fd)
		return nil
	} else if !errors.Is(err, unix.ENOENT) {
		return err
	}
	cur, err := unix.Dup(d.root)
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(cur) }()
	done := ""
	for elem := range strings.SplitSeq(rel, "/") {
		done = joinRel(done, elem)
		next, err := openat2(cur, elem, unix.O_RDONLY|unix.O_DIRECTORY, 0)
		if errors.Is(err, unix.ENOENT) {
			if err := unix.Mkdirat(cur, elem, uint32(perm.Perm())); err != nil && !errors.Is(err, unix.EEXIST) {
				return &fs.PathError{Op: "mkdir", Path: done, Err: err}
			}
			next, err = openat2(cur, elem, unix.O_RDONLY|unix.O_DIRECTORY, 0)
			if err == nil {
				err = unix.Fchown(next, o.uid, o.gid)
				if err == nil {
					err = unix.Fchmod(next, uint32(perm.Perm()))
				}
				if err != nil {
					_ = unix.Close(next)
				}
			}
		}
		if err != nil {
			return confined("mkdir", done, err)
		}
		_ = unix.Close(cur)
		cur = next
	}
	return nil
}

func joinRel(a, b string) string {
	if a == "" {
		return b
	}
	return a + "/" + b
}

// Lstat implements extractDir.
func (d *beneathDir) Lstat(rel string) (fs.FileMode, error) {
	pfd, base, err := d.parent(rel)
	if err != nil {
		return 0, err
	}
	var st unix.Stat_t
	if err := unix.Fstatat(pfd, base, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return 0, &fs.PathError{Op: "lstat", Path: rel, Err: err}
	}
	switch st.Mode & unix.S_IFMT {
	case unix.S_IFDIR:
		return fs.ModeDir, nil
	case unix.S_IFLNK:
		return fs.ModeSymlink, nil
	case unix.S_IFREG:
		return 0, nil
	default:
		return fs.ModeIrregular, nil
	}
}

// Mkdir implements extractDir.
func (d *beneathDir) Mkdir(rel string, perm fs.FileMode) error {
	pfd, base, err := d.parent(rel)
	if err != nil {
		return err
	}
	if err := unix.Mkdirat(pfd, base, uint32(perm.Perm())); err != nil {
		return &fs.PathError{Op: "mkdir", Path: rel, Err: err}
	}
	return nil
}

// Create implements extractDir.
func (d *beneathDir) Create(rel string, perm fs.FileMode) (*os.File, error) {
	pfd, base, err := d.parent(rel)
	if err != nil {
		return nil, err
	}
	fd, err := openat2(pfd, base, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW, uint32(perm.Perm()))
	if err != nil {
		return nil, confined("create", rel, err)
	}
	return os.NewFile(uintptr(fd), rel), nil
}

// Symlink implements extractDir.
func (d *beneathDir) Symlink(target, rel string) error {
	pfd, base, err := d.parent(rel)
	if err != nil {
		return err
	}
	if err := unix.Symlinkat(target, pfd, base); err != nil {
		return &fs.PathError{Op: "symlink", Path: rel, Err: err}
	}
	return nil
}

// Link implements extractDir.
func (d *beneathDir) Link(oldRel, newRel string) error {
	odir, obase := splitRel(oldRel)
	ofd, err := d.openDir(odir)
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(ofd) }()
	pfd, base, err := d.parent(newRel)
	if err != nil {
		return err
	}
	// Flags 0: a symlink as the old path is linked itself, not followed.
	if err := unix.Linkat(ofd, obase, pfd, base, 0); err != nil {
		return &fs.PathError{Op: "link", Path: newRel, Err: err}
	}
	return nil
}

// Remove implements extractDir.
func (d *beneathDir) Remove(rel string) error {
	pfd, base, err := d.parent(rel)
	if err != nil {
		return err
	}
	if err := unix.Unlinkat(pfd, base, 0); err != nil {
		return &fs.PathError{Op: "remove", Path: rel, Err: err}
	}
	return nil
}

// Lchown implements extractDir.
func (d *beneathDir) Lchown(rel string, o owner) error {
	pfd, base, err := d.parent(rel)
	if err != nil {
		return err
	}
	if err := unix.Fchownat(pfd, base, o.uid, o.gid, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &fs.PathError{Op: "chown", Path: rel, Err: err}
	}
	return nil
}

// ChmodDir implements extractDir.
func (d *beneathDir) ChmodDir(rel string, mode uint32) error {
	fd, err := d.openDir(rel)
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(fd) }()
	if err := unix.Fchmod(fd, mode); err != nil {
		return &fs.PathError{Op: "chmod", Path: rel, Err: err}
	}
	return nil
}

// Chtimes implements extractDir.
func (d *beneathDir) Chtimes(rel string, mtime time.Time) error {
	pfd, base, err := d.parent(rel)
	if err != nil {
		return err
	}
	ts := unix.NsecToTimespec(mtime.UnixNano())
	if err := unix.UtimesNanoAt(pfd, base, []unix.Timespec{ts, ts}, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &fs.PathError{Op: "chtimes", Path: rel, Err: err}
	}
	return nil
}

// Close implements extractDir.
func (d *beneathDir) Close() error {
	d.dropCache()
	return unix.Close(d.root)
}
