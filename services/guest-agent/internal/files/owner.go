package files

import (
	"errors"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
)

// owner is the uid and gid that new files and directories get (spec 4).
type owner struct{ uid, gid int }

// ownerOf is the owner of entries created for u.
func ownerOf(u *process.User) owner { return owner{uid: int(u.UID), gid: int(u.GID)} }

// lookupUser resolves a user name; an unknown name is user_not_found.
func lookupUser(name string) (*process.User, error) {
	u, err := process.LookupUser(name)
	if errors.Is(err, process.ErrUserNotFound) {
		return nil, errs.Newf(connect.CodeInvalidArgument, errs.UserNotFound, "user %q not found", name)
	}
	if err != nil {
		return nil, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	return u, nil
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

// resolveOwner parses an owner field, "user" or "user:group". Empty means
// the request user u. A user alone takes its primary group.
func resolveOwner(spec string, u *process.User) (owner, error) {
	if spec == "" {
		return ownerOf(u), nil
	}
	name, group, hasGroup := strings.Cut(spec, ":")
	ou, err := lookupUser(name)
	if err != nil {
		return owner{}, err
	}
	o := ownerOf(ou)
	if hasGroup {
		gid, err := lookupGroup(group)
		if err != nil {
			return owner{}, err
		}
		o.gid = int(gid)
	}
	return o, nil
}

// toFileMode converts Unix permission bits (with setuid, setgid and sticky)
// to an fs.FileMode.
func toFileMode(m uint32) fs.FileMode {
	mode := fs.FileMode(m & 0o777)
	if m&0o4000 != 0 {
		mode |= fs.ModeSetuid
	}
	if m&0o2000 != 0 {
		mode |= fs.ModeSetgid
	}
	if m&0o1000 != 0 {
		mode |= fs.ModeSticky
	}
	return mode
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

// parseMode parses a mode query parameter in octal ("644", "0644", "0o644").
func parseMode(s string) (uint32, error) {
	s = strings.TrimPrefix(strings.TrimPrefix(s, "0o"), "0O")
	m, err := strconv.ParseUint(s, 8, 32)
	if err != nil || m > 0o7777 {
		return 0, errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, "mode %q is not an octal mode", s)
	}
	return uint32(m), nil
}

// names caches uid and gid to name lookups for one request.
type names struct {
	users  map[uint32]string
	groups map[uint32]string
}

func newNames() *names {
	return &names{users: map[uint32]string{}, groups: map[uint32]string{}}
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

// buildInfo describes fi found at path. target is the symlink target of a
// symlink reported as such.
func buildInfo(path string, fi fs.FileInfo, target string, n *names) *agentv1.FileInfo {
	sys := sysOf(fi)
	info := &agentv1.FileInfo{
		Path:  path,
		Name:  filepath.Base(path),
		Size:  uint64(max(fi.Size(), 0)),
		Mode:  fromFileMode(fi.Mode()),
		Uid:   sys.uid,
		Gid:   sys.gid,
		Owner: n.user(sys.uid),
		Group: n.group(sys.gid),
		Mtime: timestamppb.New(fi.ModTime()),
	}
	switch {
	case fi.Mode().IsRegular():
		info.Type = agentv1.FileType_FILE_TYPE_FILE
	case fi.IsDir():
		info.Type = agentv1.FileType_FILE_TYPE_DIR
	case fi.Mode()&fs.ModeSymlink != 0:
		info.Type = agentv1.FileType_FILE_TYPE_SYMLINK
		info.SymlinkTarget = target
	default:
		info.Type = agentv1.FileType_FILE_TYPE_OTHER
	}
	return info
}

// statInfo describes path; follow selects Stat over Lstat. Errors are not
// mapped.
func statInfo(path string, follow bool, n *names) (*agentv1.FileInfo, error) {
	var fi fs.FileInfo
	var err error
	if follow {
		fi, err = os.Stat(path)
	} else {
		fi, err = os.Lstat(path)
	}
	if err != nil {
		return nil, err
	}
	var target string
	if fi.Mode()&fs.ModeSymlink != 0 {
		target, _ = os.Readlink(path)
	}
	return buildInfo(path, fi, target, n), nil
}

// mkdirAll creates dir and its missing parents with perm (exactly, not
// masked by the umask) and gives the new directories to o. An existing
// non-directory on the way is ENOTDIR.
func mkdirAll(dir string, perm fs.FileMode, o owner) error {
	fi, err := os.Stat(dir)
	if err == nil {
		if fi.IsDir() {
			return nil
		}
		return &fs.PathError{Op: "mkdir", Path: dir, Err: syscall.ENOTDIR}
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if parent := filepath.Dir(dir); parent != dir {
		if err := mkdirAll(parent, perm, o); err != nil {
			return err
		}
	}
	return mkdirOwned(dir, perm, o)
}

// mkdirOwned creates one directory with perm and owner o. A directory that
// appeared concurrently is accepted.
func mkdirOwned(dir string, perm fs.FileMode, o owner) error {
	if err := os.Mkdir(dir, perm); err != nil {
		if errors.Is(err, fs.ErrExist) {
			if fi, serr := os.Stat(dir); serr == nil && fi.IsDir() {
				return nil
			}
		}
		return err
	}
	if err := os.Chmod(dir, perm); err != nil {
		return err
	}
	return lchown(dir, o)
}

// followLinks resolves p while its last element is a symlink, so a write to
// p replaces the file the link points to, not the link (spec 11.1). A
// dangling link resolves to its missing target.
func followLinks(p string) (string, error) {
	for range 40 {
		fi, err := os.Lstat(p)
		if err != nil || fi.Mode()&fs.ModeSymlink == 0 {
			return p, nil
		}
		target, err := os.Readlink(p)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(p), target)
		}
		p = filepath.Clean(target)
	}
	return "", &fs.PathError{Op: "open", Path: p, Err: syscall.ELOOP}
}
