//go:build !linux

package quiesce

import "errors"

// unsupportedFreezer is the freezer of platforms without FIFREEZE.
type unsupportedFreezer struct{}

// NewFreezer returns the freezer of this platform; outside Linux every
// method fails with errors.ErrUnsupported.
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
