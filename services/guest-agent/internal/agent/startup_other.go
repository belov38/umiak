//go:build !windows

package agent

import "context"

// defaultStartSSH does nothing outside Windows: systemd starts sshd.
func defaultStartSSH(context.Context) error { return nil }
