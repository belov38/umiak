//go:build !linux && !windows

package quiesce

import "errors"

// Platform behaviour of Quiesce. Other platforms (macOS, for development
// and tests) keep the Linux flow.
const (
	freezesFS = true
	// WipesSecretFiles is false: there is no secret file wipe on quiesce.
	WipesSecretFiles = false
)

// unsupportedFreezer is the freezer of platforms without FIFREEZE.
type unsupportedFreezer struct{}

// NewFreezer returns the freezer of this platform; here every method fails
// with errors.ErrUnsupported.
func NewFreezer() Freezer {
	return unsupportedFreezer{}
}

// Mounts implements Freezer.
func (unsupportedFreezer) Mounts() ([]Mount, error) { return nil, errors.ErrUnsupported }

// Freeze implements Freezer.
func (unsupportedFreezer) Freeze(string) error { return errors.ErrUnsupported }

// Thaw implements Freezer.
func (unsupportedFreezer) Thaw(string) error { return errors.ErrUnsupported }

// syncAll is a no-op outside Linux.
func syncAll() {}
