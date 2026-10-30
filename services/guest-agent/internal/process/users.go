package process

import (
	"errors"
	"fmt"
)

// ErrUserNotFound is returned by LookupUser for an unknown user name.
var ErrUserNotFound = errors.New("process: user not found")

// User is a resolved account that commands run as.
type User struct {
	Name   string
	UID    uint32
	GID    uint32
	Groups []uint32
	Home   string
	Shell  string
	// Windows is set on Windows, where accounts have no numeric ids.
	Windows *WinUser
}

// WinUser is the Windows part of a User (spec 12.5).
type WinUser struct {
	// Account is the local account name for LogonUserW.
	Account string
	// System: the command runs with the token of the agent (SYSTEM).
	System bool
}

// LookupUser resolves name. On Linux it goes through os/user (the pure Go
// implementation reads /etc/passwd and /etc/group when built without cgo);
// on Windows only the default account and SYSTEM exist (spec 12.5).
func LookupUser(name string) (*User, error) {
	if name == "" {
		return nil, fmt.Errorf("%w: empty name", ErrUserNotFound)
	}
	return lookupUser(name)
}
