package claim

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The Windows secret store (S9 spec 12.8): secret files on NTFS under
// C:\ProgramData\sbx\secrets\files with a SYSTEM + user ACL, wiped with a
// zero overwrite; secret_env only in memory.

const (
	// appliesHostname: Windows keeps its SBX<hex> name, renaming needs a
	// reboot (spec 11.3); the claim hostname is only SBX_HOSTNAME.
	appliesHostname = false
	// secretEnvMemoryOnly forces Options.SecretEnvInMemory.
	secretEnvMemoryOnly = true
)

// wipeChunk is the size of one zero write.
const wipeChunk = 64 << 10

// mountSecrets creates the secrets root (there is no tmpfs on Windows) and
// keeps it to SYSTEM and Administrators.
func mountSecrets(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return setDACL(dir, mountSDDL)
}

// validLinkPath reports whether a link_path is an absolute path on a drive
// ("C:\x" or "C:/x") without ".." elements other than the drive root. UNC,
// device, rooted ("\x") and drive-relative ("C:x") paths are refused.
func validLinkPath(lp string) bool {
	vol := filepath.VolumeName(lp)
	if len(vol) != 2 || !filepath.IsAbs(lp) {
		return false
	}
	for elem := range strings.SplitSeq(filepath.ToSlash(lp), "/") {
		if elem == ".." {
			return false
		}
	}
	return filepath.Clean(lp) != vol+`\`
}

// secureDir gives a secrets directory its protected DACL: with group the
// default user may list it (secretDirACL), otherwise it is SYSTEM-only.
func (m *Manager) secureDir(path string, _ fs.FileMode, group bool) error {
	sddl := secretDirSDDL
	if group {
		sddl = secretDirACL(m.userSID())
	}
	return setDACL(path, sddl)
}

// writeGroupFile writes a secret file with the DACL for mode and the
// default user (writeSecret).
func (m *Manager) writeGroupFile(path string, data []byte, mode fs.FileMode) error {
	if err := writeSecret(path, data, mode, m.userSID()); err != nil {
		return internal("write secret", err)
	}
	return nil
}

// userSID returns the SID of the default user, or nil (SYSTEM-only ACLs)
// when the user is unknown.
func (m *Manager) userSID() *windows.SID {
	m.mu.RLock()
	u := m.user
	m.mu.RUnlock()
	if u == nil {
		return nil
	}
	account := u.Name
	if u.Windows != nil && u.Windows.Account != "" {
		account = u.Windows.Account
	}
	sid, err := lookupAccountSID(account)
	if err != nil {
		m.log.Warn("default user has no SID, secrets stay SYSTEM-only", "user", account, "err", err)
		return nil
	}
	return sid
}

// mkdirAllOwned creates the missing parents of a link_path. Inside the
// profile they inherit the user's access, so nothing is chowned.
func (m *Manager) mkdirAllOwned(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

// removeSecretFile wipes a regular file (wipeFile) and removes anything
// else (links, directories) without following it.
func removeSecretFile(path string) error {
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		return err
	case fi.Mode().IsRegular():
		return wipeFile(path)
	default:
		return os.RemoveAll(path)
	}
}

// tmpSuffix names the file a secret is written to before the rename; "~"
// is not allowed in secret names, so it never collides with one.
const tmpSuffix = "~sbx-tmp"

// writeSecret writes data as the secret file path. The content goes to a
// new file created with FILE_ATTRIBUTE_TEMPORARY and its final DACL
// (secretFileACL), and is never flushed: the cache manager keeps a
// temporary file in memory as long as it can. An existing file is
// overwritten with zeros and flushed in place, then replaced by a rename. A
// file held open without sharing write and delete access, or still being
// deleted, fails with ErrSecretInUse and is left as it was.
func writeSecret(path string, data []byte, mode fs.FileMode, user *windows.SID) error {
	tmp := path + tmpSuffix
	if err := removeSecretFile(tmp); err != nil {
		return err
	}
	if err := createSecret(tmp, data, mode, user); err != nil {
		return err
	}
	if err := replaceSecret(tmp, path); err != nil {
		if werr := wipeFile(tmp); werr != nil {
			return errors.Join(err, werr)
		}
		return err
	}
	return nil
}

// createSecret creates path (it must not exist) with the secret file DACL
// and FILE_ATTRIBUTE_TEMPORARY and writes data, without a flush.
func createSecret(path string, data []byte, mode fs.FileMode, user *windows.SID) error {
	sd, err := windows.SecurityDescriptorFromString(secretFileACL(mode, user))
	if err != nil {
		return fmt.Errorf("claim: secret file ACL: %w", err)
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	h, err := windows.CreateFile(p, windows.GENERIC_WRITE|windows.DELETE, 0, &sa,
		windows.CREATE_NEW, windows.FILE_ATTRIBUTE_TEMPORARY, 0)
	if err != nil {
		return secretFileError("create", path, err)
	}
	f := os.NewFile(uintptr(h), path)
	if _, err := f.Write(data); err != nil {
		// Nothing was flushed; deleting drops the cached data.
		_ = deleteOnClose(h)
		_ = f.Close()
		return fmt.Errorf("claim: write %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("claim: write %s: %w", path, err)
	}
	return nil
}

// replaceSecret moves tmp (in the directory of path) to path. An existing
// regular file at path is overwritten with zeros first; anything else there
// is removed.
func replaceSecret(tmp, path string) (retErr error) {
	// Keep DELETE access until replacement finishes. On failure unlink the
	// zeroed old file rather than exposing it as a successfully kept secret.
	var old *os.File
	var handle windows.Handle
	defer func() {
		if old == nil {
			return
		}
		if retErr != nil {
			retErr = errors.Join(retErr, deleteOnClose(handle))
		}
		retErr = errors.Join(retErr, old.Close())
	}()
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return secretFileError("inspect", path, err)
	case fi.Mode().IsRegular():
		var err error
		old, handle, err = openExisting(path)
		if err != nil {
			return secretFileError("open replacement", path, err)
		}
		if err := zeroFile(old); err != nil {
			return fmt.Errorf("claim: zero replacement %s: %w", path, err)
		}
	default:
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		// NTFS refuses to replace a file that is open, even by a reader
		// that shares delete (the overwrite handle let it through). A POSIX rename
		// replaces it; the reader keeps the zeroed old file.
		if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return fmt.Errorf("claim: replace %s (old secret removed): %w", path, err)
		}
		if perr := posixRename(tmp, path); perr != nil {
			return fmt.Errorf("claim: replace %s (old secret removed): %w", path, errors.Join(err, perr))
		}
	}
	return nil
}

// posixRename renames src over dst in their common directory with POSIX
// semantics (os.Root does it with FILE_RENAME_POSIX_SEMANTICS): open
// handles of dst keep the old file.
func posixRename(src, dst string) error {
	r, err := os.OpenRoot(filepath.Dir(dst))
	if err != nil {
		return err
	}
	defer r.Close() //nolint:errcheck // directory handle
	return r.Rename(filepath.Base(src), filepath.Base(dst))
}

// wipeFile overwrites path with zeros to its size, flushes it and deletes
// it, all through one handle opened with write and delete access that
// shares read, write and delete. A process holding the file open without
// sharing write or delete access makes the open fail before anything is
// changed: the error then matches ErrSecretInUse. A file already being
// deleted (an earlier wipe, its name kept by a handle that shares delete)
// counts as wiped.
func wipeFile(path string) error {
	f, h, err := openExisting(path)
	if err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) && isDeletePending(path) {
			return nil
		}
		return secretFileError("wipe", path, err)
	}
	werr := zeroFile(f)
	if werr == nil {
		werr = deleteOnClose(h)
	}
	cerr := f.Close()
	if werr != nil {
		return secretFileError("wipe", path, werr)
	}
	if cerr != nil {
		return secretFileError("wipe", path, cerr)
	}
	return nil
}

// openExisting opens path itself (not a link target) for overwrite and
// delete, sharing read, write and delete. A read-only attribute, which
// refuses write access even to SYSTEM, is cleared.
func openExisting(path string) (*os.File, windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, 0, err
	}
	h, err := openForWipe(p)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		if a, aerr := windows.GetFileAttributes(p); aerr == nil && a&windows.FILE_ATTRIBUTE_READONLY != 0 &&
			windows.SetFileAttributes(p, a&^windows.FILE_ATTRIBUTE_READONLY) == nil {
			h, err = openForWipe(p)
		}
	}
	if err != nil {
		return nil, 0, err
	}
	return os.NewFile(uintptr(h), path), h, nil
}

func openForWipe(p *uint16) (windows.Handle, error) {
	return windows.CreateFile(p, windows.GENERIC_WRITE|windows.DELETE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// zeroFile overwrites f with zeros to its size and flushes it to disk.
func zeroFile(f *os.File) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	zeros := make([]byte, min(fi.Size(), wipeChunk))
	for off := int64(0); off < fi.Size(); {
		n := min(fi.Size()-off, int64(len(zeros)))
		if _, err := f.WriteAt(zeros[:n], off); err != nil {
			return err
		}
		off += n
	}
	return f.Sync()
}

// deleteOnClose marks the file of h (opened with DELETE access) for
// deletion when its last handle closes.
func deleteOnClose(h windows.Handle) error {
	del := byte(1) // FILE_DISPOSITION_INFO.DeleteFile
	return windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, &del, 1)
}

// isDeletePending reports whether path is marked for deletion and only
// kept by open handles: Win32 reports such a file as access denied, the
// NT open as STATUS_DELETE_PENDING.
func isDeletePending(path string) bool {
	name, err := windows.NewNTUnicodeString(`\??\` + path)
	if err != nil {
		return false
	}
	oa := windows.OBJECT_ATTRIBUTES{ObjectName: name, Attributes: windows.OBJ_CASE_INSENSITIVE}
	oa.Length = uint32(unsafe.Sizeof(oa))
	var h windows.Handle
	var iosb windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&h, windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, &oa, &iosb, nil, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		windows.FILE_OPEN, windows.FILE_OPEN_REPARSE_POINT, 0, 0)
	if err == nil {
		_ = windows.CloseHandle(h)
		return false
	}
	return errors.Is(err, windows.STATUS_DELETE_PENDING)
}

// secretFileError wraps a failure of op on a secret file. A sharing or lock
// violation, or a file still being deleted, matches ErrSecretInUse (and
// keeps the errno).
func secretFileError(op, path string, err error) error {
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_USER_MAPPED_FILE) ||
		(errors.Is(err, windows.ERROR_ACCESS_DENIED) && isDeletePending(path)) {
		return fmt.Errorf("claim: %s %s: %w: %w", op, path, ErrSecretInUse, err)
	}
	return fmt.Errorf("claim: %s %s: %w", op, path, err)
}
