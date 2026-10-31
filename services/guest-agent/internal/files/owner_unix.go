//go:build !windows

package files

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// errNotDir is the errno of a non-directory in the way.
var errNotDir error = syscall.ENOTDIR

// sysInfo is the part of a stat result that fs.FileInfo does not expose.
type sysInfo struct {
	ino, dev uint64
	uid, gid uint32
}

// sysOf returns the inode, device and owner of fi.
func sysOf(fi fs.FileInfo) sysInfo {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return sysInfo{}
	}
	return sysInfo{ino: uint64(st.Ino), dev: uint64(st.Dev), uid: st.Uid, gid: st.Gid} //nolint:unconvert // types differ per OS
}

// lchown gives path (not a symlink target) to o.
func lchown(path string, o owner) error {
	return os.Lchown(path, o.uid, o.gid)
}

// fchown gives the open file f to o.
func fchown(f *os.File, o owner) error {
	return f.Chown(o.uid, o.gid)
}

// rootLchown gives name inside r (not a symlink target) to o. Only the
// os.Root unpack of non-Linux systems uses it.
//
//nolint:unused // used by archive_put_other.go
func rootLchown(r *os.Root, name string, o owner) error {
	return r.Lchown(name, o.uid, o.gid)
}

// openRead opens path for reading without blocking on a FIFO.
func openRead(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}

// deviceOf returns the device of the nearest existing ancestor of p
// (p included).
func deviceOf(p string) (uint64, bool) {
	for {
		fi, err := os.Stat(p)
		if err == nil {
			return sysOf(fi).dev, true
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return 0, false
		}
		parent := filepath.Dir(p)
		if parent == p {
			return 0, false
		}
		p = parent
	}
}

// isNotEmpty reports a "directory not empty" error.
func isNotEmpty(err error) bool {
	return errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST)
}

// lookupGroup resolves a group name to its gid; an unknown group is
// user_not_found (the spec has no separate code for groups).
func lookupGroup(name string) (uint32, error) {
	g, err := user.LookupGroup(name)
	if err != nil {
		var unknown user.UnknownGroupError
		if errors.As(err, &unknown) {
			return 0, errs.Newf(connect.CodeInvalidArgument, errs.UserNotFound, "group %q not found", name)
		}
		return 0, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	gid, err := strconv.ParseUint(g.Gid, 10, 32)
	if err != nil {
		return 0, errs.Newf(connect.CodeInternal, errs.Internal, "group %s: gid %q", name, g.Gid)
	}
	return uint32(gid), nil
}

func (n *names) user(uid uint32) string {
	if name, ok := n.users[uid]; ok {
		return name
	}
	var name string
	if u, err := user.LookupId(strconv.FormatUint(uint64(uid), 10)); err == nil {
		name = u.Username
	}
	n.users[uid] = name
	return name
}

func (n *names) group(gid uint32) string {
	if name, ok := n.groups[gid]; ok {
		return name
	}
	var name string
	if g, err := user.LookupGroupId(strconv.FormatUint(uint64(gid), 10)); err == nil {
		name = g.Name
	}
	n.groups[gid] = name
	return name
}

// isLink reports whether fi (from Lstat or Stat of path) is a symlink.
func isLink(_ string, fi fs.FileInfo) bool { return fi.Mode()&fs.ModeSymlink != 0 }

// setOwnerMode fills the mode and the owner of info from fi.
func setOwnerMode(info *agentv1.FileInfo, _ string, fi fs.FileInfo, _ bool, n *names) {
	sys := sysOf(fi)
	info.Mode = fromFileMode(fi.Mode())
	info.Uid, info.Gid = sys.uid, sys.gid
	info.Owner, info.Group = n.user(sys.uid), n.group(sys.gid)
}

// etagOf is the ETag of the open file f: "<inode>-<size>-<mtime_ns>".
func etagOf(_ *os.File, fi fs.FileInfo) string {
	return fmt.Sprintf(`"%d-%d-%d"`, sysOf(fi).ino, fi.Size(), fi.ModTime().UnixNano())
}

// fromFileMode is the inverse of toFileMode: Unix permission bits.
func fromFileMode(m fs.FileMode) uint32 {
	bits := uint32(m.Perm())
	if m&fs.ModeSetuid != 0 {
		bits |= 0o4000
	}
	if m&fs.ModeSetgid != 0 {
		bits |= 0o2000
	}
	if m&fs.ModeSticky != 0 {
		bits |= 0o1000
	}
	return bits
}
