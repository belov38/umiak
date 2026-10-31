//go:build !windows

package ident

import "context"

// SetupInProgress reports whether Windows Setup is running; never outside
// Windows.
func SetupInProgress() bool { return false }

// lockIdentity is a no-op outside Windows: the Windows identity steps only
// run in tests here.
func lockIdentity(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return func() {}, nil
}

// secureSSHFile leaves the permissions alone outside Windows.
func secureSSHFile(string) error { return nil }
