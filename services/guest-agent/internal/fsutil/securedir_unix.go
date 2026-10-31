//go:build !windows

package fsutil

import "os"

// MkdirSecure creates dir (and parents) and makes it 0700.
func MkdirSecure(dir string, _ DirAccess) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

// IsSecure reports whether dir is a directory of mode 0700 (MkdirSecure).
func IsSecure(dir string, _ DirAccess) (bool, error) {
	fi, err := os.Stat(dir)
	if err != nil {
		return false, err
	}
	return fi.IsDir() && fi.Mode().Perm() == 0o700, nil
}

// TrustedOwner reports whether path belongs to the system. Outside Windows
// the directories are 0700, so every file in them is trusted.
func TrustedOwner(string) (bool, error) { return true, nil }
