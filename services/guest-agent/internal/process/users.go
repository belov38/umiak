package process

import (
	"errors"
	"fmt"
	"os/user"
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
}

// LookupUser resolves name through os/user (the pure Go implementation reads
// /etc/passwd and /etc/group when built without cgo).
func LookupUser(name string) (*User, error) {
	if name == "" {
		return nil, fmt.Errorf("%w: empty name", ErrUserNotFound)
	}
	u, err := user.Lookup(name)
	if err != nil {
		var unknown user.UnknownUserError
		if errors.As(err, &unknown) {
			return nil, fmt.Errorf("%w: %s", ErrUserNotFound, name)
		}
		return nil, fmt.Errorf("process: lookup user %s: %w", name, err)
	}
	return fromOSUser(u)
}
