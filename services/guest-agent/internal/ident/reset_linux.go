package ident

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"

	"golang.org/x/sys/unix"
)

// cmdTimeout bounds every helper process started by the resetter.
const cmdTimeout = 60 * time.Second

// SetHostname sets the kernel hostname.
func (LinuxResetter) SetHostname(name string) error {
	if err := unix.Sethostname([]byte(name)); err != nil {
		return fmt.Errorf("ident: sethostname: %w", err)
	}
	return nil
}

// RegenerateHostKeys removes ssh_host_* from the SSH directory and runs
// ssh-keygen -A.
func (r LinuxResetter) RegenerateHostKeys() error {
	if err := removeHostKeys(r.Layout.SSHDir); err != nil {
		return err
	}
	if err := os.MkdirAll(r.Layout.SSHDir, 0o755); err != nil {
		return err
	}
	return run("ssh-keygen", "-A")
}

// ReloadNetwork asks systemd-networkd to renew the leases of all links except
// loopback.
func (LinuxResetter) ReloadNetwork() error {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return fmt.Errorf("ident: list links: %w", err)
	}
	args := []string{"renew"}
	for _, e := range entries {
		if e.Name() != "lo" {
			args = append(args, e.Name())
		}
	}
	if len(args) == 1 {
		return nil
	}
	return run("networkctl", args...)
}

// RestartSSH restarts ssh.service if it is active.
func (LinuxResetter) RestartSSH() error {
	return run("systemctl", "try-restart", "ssh")
}

// RestartJournal restarts systemd-journald.service if it is active. The call
// waits for the restart: umiak-identity.service runs before
// systemd-journal-flush.service, so the flush to /var/log/journal goes under
// the new machine-id and takes the earlier entries of the boot with it.
func (LinuxResetter) RestartJournal() error {
	return run("systemctl", "try-restart", "systemd-journald.service")
}

// run executes a helper and wraps a failure with its trimmed output.
func run(name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ident: %s: %w: %s", name, err, truncate(out, 512))
	}
	return nil
}

func truncate(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	return string(b)
}
