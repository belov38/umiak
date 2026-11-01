//go:build !windows

package desktop

import (
	"context"
	"errors"
)

// RunWebService is only needed for the Windows SCM wrapper.
func RunWebService(context.Context) error { return errors.New("SCM wrapper requires Windows") }
