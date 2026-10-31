package files

import (
	"fmt"
	"io/fs"
	"os"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/winapi"
)

// NTFS has no Unix modes or numeric owners. FileInfo synthesizes the mode
// (synthMode), reports the account of the owner SID and leaves group, uid
// and gid empty (S9 spec 12.9).

// isLink reports whether fi (from Lstat or Stat of path) is shown as a
// symlink: a symlink or a junction (mount point). Go reports a junction as
// ModeIrregular; its reparse tag tells it apart from other reparse points.
func isLink(path string, fi fs.FileInfo) bool {
	m := fi.Mode()
	if m&fs.ModeSymlink != 0 {
		return true
	}
	if m&fs.ModeIrregular == 0 {
		return false
	}
	tag, err := reparseTag(path)
	return err == nil && tag == windows.IO_REPARSE_TAG_MOUNT_POINT
}

// fileAttributeTagInfo is FILE_ATTRIBUTE_TAG_INFO.
type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// reparseTag returns the reparse tag of path itself (0 for no reparse
// point).
func reparseTag(path string) (uint32, error) {
	h, err := openHandle(path, windows.FILE_READ_ATTRIBUTES, false)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(h) //nolint:errcheck // read-only handle
	var ti fileAttributeTagInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileAttributeTagInfo,
		(*byte)(unsafe.Pointer(&ti)), uint32(unsafe.Sizeof(ti))); err != nil {
		return 0, err
	}
	if ti.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		return 0, nil
	}
	return ti.ReparseTag, nil
}

// setOwnerMode fills the synthesized mode and the owner account of info. A
// link or another reparse point is described itself, everything else
// through path as fi was.
func setOwnerMode(info *agentv1.FileInfo, path string, fi fs.FileInfo, link bool, n *names) {
	readOnly := fi.Mode()&0o200 == 0
	info.Mode = synthMode(info.GetName(), fi.IsDir(), link, readOnly, os.Getenv("PATHEXT"))
	follow := !link && fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) == 0
	info.Owner = n.ownerName(path, follow)
}

// ownerName returns the account name of the owner of path, the SID string
// when the SID maps to no account, or "" when the owner is unreadable.
func (n *names) ownerName(path string, follow bool) string {
	enableFSPrivileges()
	h, err := openHandle(path, windows.READ_CONTROL, follow)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h) //nolint:errcheck // read-only handle
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return ""
	}
	sid, _, err := sd.Owner()
	if err != nil || sid == nil {
		return ""
	}
	return n.account(sid)
}

// account returns the account name of sid (without the domain), or the SID
// string when it maps to no account.
func (n *names) account(sid *windows.SID) string {
	key := sid.String()
	if name, ok := n.accounts[key]; ok {
		return name
	}
	name, _, _, err := sid.LookupAccount("")
	if err != nil || name == "" {
		name = key
	}
	n.accounts[key] = name
	return name
}

// etagOf is the ETag of the open file f:
// "<volume serial>-<file index>-<size>-<mtime_ns>".
func etagOf(f *os.File, fi fs.FileInfo) string {
	var d windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &d); err != nil {
		return fmt.Sprintf(`"%d-%d"`, fi.Size(), fi.ModTime().UnixNano())
	}
	idx := uint64(d.FileIndexHigh)<<32 | uint64(d.FileIndexLow)
	return fmt.Sprintf(`"%d-%d-%d-%d"`, d.VolumeSerialNumber, idx, fi.Size(), fi.ModTime().UnixNano())
}

// accountSIDs caches the SID of account names for lchown.
var accountSIDs sync.Map // string -> *windows.SID

// accountSID returns the SID of a local account name.
func accountSID(name string) (*windows.SID, error) {
	if v, ok := accountSIDs.Load(name); ok {
		return v.(*windows.SID), nil
	}
	sid, _, _, err := windows.LookupSID("", name)
	if err != nil {
		return nil, fmt.Errorf("lookup account %s: %w", name, err)
	}
	accountSIDs.Store(name, sid)
	return sid, nil
}

// lchown makes the account of o the owner of path (not of a link target).
// An owner without an account is a no-op. Setting another account than the
// caller as owner takes SeRestorePrivilege, which SYSTEM holds.
func lchown(path string, o owner) error {
	if o.account == "" {
		return nil
	}
	sid, err := accountSID(o.account)
	if err != nil {
		return &fs.PathError{Op: "chown", Path: path, Err: err}
	}
	enableFSPrivileges()
	h, err := openHandle(path, windows.WRITE_OWNER, false)
	if err != nil {
		return &fs.PathError{Op: "chown", Path: path, Err: err}
	}
	defer windows.CloseHandle(h) //nolint:errcheck // nothing buffered
	if err := windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION,
		sid, nil, nil, nil); err != nil {
		return &fs.PathError{Op: "chown", Path: path, Err: err}
	}
	return nil
}

// openHandle opens path (a file or a directory) with access and full
// sharing; follow=false opens a reparse point itself. Backup semantics let
// the enabled backup and restore privileges bypass the DACL.
func openHandle(path string, access uint32, follow bool) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	flags := uint32(windows.FILE_FLAG_BACKUP_SEMANTICS)
	if !follow {
		flags |= windows.FILE_FLAG_OPEN_REPARSE_POINT
	}
	return windows.CreateFile(p, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, flags, 0)
}

// enableFSPrivileges enables the backup and restore privileges of the agent
// once (SYSTEM holds them; the service token may have them disabled). A
// token without them keeps failing on the DACL; privileges of a token never
// grow, so the attempt is not repeated.
var enableFSPrivileges = sync.OnceFunc(func() {
	_ = winapi.EnablePrivileges("SeBackupPrivilege", "SeRestorePrivilege")
})
