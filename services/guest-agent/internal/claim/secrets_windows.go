package claim

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

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

// writeGroupFile writes a secret file and gives it the DACL for mode and the
// default user (secureSecretFile). The file is written writable: access is
// decided by the DACL, a read-only attribute would only block the wipe.
func (m *Manager) writeGroupFile(path string, data []byte, mode fs.FileMode) error {
	if err := m.writeFile(path, data, 0o600); err != nil {
		return internal("write secret", err)
	}
	if err := secureSecretFile(path, mode, m.userSID()); err != nil {
		return internal("secure secret", err)
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

// wipeFile overwrites path with zeros to its size, flushes it and deletes
// it, all through one handle opened with write and delete access that
// shares read, write and delete. A process holding the file open without
// sharing write or delete access makes the open fail before anything is
// changed: the error then matches ErrSecretInUse.
func wipeFile(path string) error {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	h, err := openForWipe(p)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		// The read-only attribute refuses write access even to SYSTEM.
		if a, aerr := windows.GetFileAttributes(p); aerr == nil && a&windows.FILE_ATTRIBUTE_READONLY != 0 &&
			windows.SetFileAttributes(p, a&^windows.FILE_ATTRIBUTE_READONLY) == nil {
			h, err = openForWipe(p)
		}
	}
	if err != nil {
		return wipeError(path, err)
	}
	f := os.NewFile(uintptr(h), path)
	werr := zeroAndDelete(f, h)
	cerr := f.Close()
	if werr != nil {
		return wipeError(path, werr)
	}
	if cerr != nil {
		return wipeError(path, cerr)
	}
	return nil
}

// openForWipe opens p itself (not a link target) for overwrite and delete.
func openForWipe(p *uint16) (windows.Handle, error) {
	return windows.CreateFile(p, windows.GENERIC_WRITE|windows.DELETE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// zeroAndDelete overwrites f with zeros, flushes it to disk and marks it
// for deletion on close.
func zeroAndDelete(f *os.File, h windows.Handle) error {
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
	if err := f.Sync(); err != nil {
		return err
	}
	del := byte(1) // FILE_DISPOSITION_INFO.DeleteFile
	return windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, &del, 1)
}

// wipeError wraps a wipe failure; a sharing or lock violation matches
// ErrSecretInUse (and the errno, for file_in_use).
func wipeError(path string, err error) error {
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_USER_MAPPED_FILE) {
		return fmt.Errorf("claim: wipe %s: %w: %w", path, ErrSecretInUse, err)
	}
	return fmt.Errorf("claim: wipe %s: %w", path, err)
}
