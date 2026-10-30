//go:build !linux && !windows

package ident

import (
	"context"
	"errors"
)

// Read is not supported outside Linux.
func (SysfsSource) Read(context.Context) (Raw, error) {
	return Raw{}, errors.ErrUnsupported
}
