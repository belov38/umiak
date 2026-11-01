package files

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
	"github.com/belov38/umiak/services/guest-agent/internal/process"
)

// owner is the uid and gid that new files and directories get (spec 4). On
// Windows only account counts: the account name whose SID becomes the owner.
type owner struct {
	uid, gid int
	account  string
}

// ownerOf is the owner of entries created for u.
func ownerOf(u *process.User) owner {
	return owner{uid: int(u.UID), gid: int(u.GID), account: accountOf(u)}
}

// accountOf is the Windows account name of u, empty elsewhere.
func accountOf(u *process.User) string {
	if u.Windows == nil {
		return ""
	}
	return u.Windows.Account
}

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

// parseMode parses a mode query parameter in octal ("644", "0644", "0o644").
func parseMode(s string) (uint32, error) {
	s = strings.TrimPrefix(strings.TrimPrefix(s, "0o"), "0O")
	m, err := strconv.ParseUint(s, 8, 32)
	if err != nil || m > 0o7777 {
		return 0, errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, "mode %q is not an octal mode", s)
	}
	return uint32(m), nil
}

// names caches uid, gid and (on Windows) SID to name lookups for one
// request.
type names struct {
	users    map[uint32]string
	groups   map[uint32]string
	accounts map[string]string
}

func newNames() *names {
	return &names{users: map[uint32]string{}, groups: map[uint32]string{}, accounts: map[string]string{}}
}

// buildInfo describes fi found at path. link reports a symlink (or, on
// Windows, a junction) shown as such; target is its target.
func buildInfo(path string, fi fs.FileInfo, link bool, target string, n *names) *agentv1.FileInfo {
	info := &agentv1.FileInfo{
		Path:  path,
		Name:  filepath.Base(path),
		Size:  uint64(max(fi.Size(), 0)),
		Mtime: timestamppb.New(fi.ModTime()),
	}
	switch {
	case link:
		info.Type = agentv1.FileType_FILE_TYPE_SYMLINK
		info.SymlinkTarget = target
	case fi.Mode().IsRegular():
		info.Type = agentv1.FileType_FILE_TYPE_FILE
	case fi.IsDir():
		info.Type = agentv1.FileType_FILE_TYPE_DIR
	default:
		info.Type = agentv1.FileType_FILE_TYPE_OTHER
	}
	setOwnerMode(info, path, fi, link, n)
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
	link := isLink(path, fi)
	var target string
	if link {
		target, _ = os.Readlink(path)
	}
	return buildInfo(path, fi, link, target, n), nil
}

// mkdirAll creates dir and its missing parents with perm (exactly, not
// masked by the umask) and gives the new directories to o. An existing
// non-directory on the way is errNotDir.
func mkdirAll(dir string, perm fs.FileMode, o owner) error {
	fi, err := os.Stat(dir)
	if err == nil {
		if fi.IsDir() {
			return nil
		}
		return &fs.PathError{Op: "mkdir", Path: dir, Err: errNotDir}
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
