//go:build !linux

package supervisor

import (
	"context"
	"errors"
)

// NewSystemd needs systemd and cgroups v2; elsewhere it returns
// errors.ErrUnsupported.
func NewSystemd(_ context.Context, _ string, _ string) (Supervisor, error) {
	return nil, errors.ErrUnsupported
}
