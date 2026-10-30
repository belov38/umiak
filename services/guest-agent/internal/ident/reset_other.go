//go:build !linux

package ident

import "errors"

// SetHostname is not supported outside Linux.
func (LinuxResetter) SetHostname(string) error { return errors.ErrUnsupported }

// RegenerateHostKeys is not supported outside Linux.
func (LinuxResetter) RegenerateHostKeys() error { return errors.ErrUnsupported }

// ReloadNetwork is not supported outside Linux.
func (LinuxResetter) ReloadNetwork() error { return errors.ErrUnsupported }

// RestartSSH is not supported outside Linux.
func (LinuxResetter) RestartSSH() error { return errors.ErrUnsupported }
