package process

import (
	"errors"
	"fmt"
	"os/user"
)

// fromOSUser is not supported on Windows: accounts have SIDs, not numeric
// ids. S9 brings its own user model.
func fromOSUser(u *user.User) (*User, error) {
	return nil, fmt.Errorf("process: user %s: %w", u.Username, errors.ErrUnsupported)
}
