//go:build !linux && !windows

package claim

import "errors"

// mountSecrets is Linux and Windows only.
func mountSecrets(string) error {
	return errors.ErrUnsupported
}
