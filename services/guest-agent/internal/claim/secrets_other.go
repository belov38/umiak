//go:build !linux

package claim

import "errors"

// mountSecrets is Linux only.
func mountSecrets(string) error {
	return errors.ErrUnsupported
}
