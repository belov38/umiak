package update

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// ServiceManager starts the agent service for Rollback: SystemctlManager
// on Linux, SCMManager on Windows. Start and Restart do not wait for the
// agent to become ready.
type ServiceManager interface {
	Start(name string) error
	Restart(name string) error
	// ResetFailed clears a start limit (systemd); a no-op on Windows.
	ResetFailed(name string) error
}

// SystemctlManager is the ServiceManager of systemd. Start and Restart do
// not wait for the unit (--no-block): the rollback unit must not wait for
// the agent's readiness, and the agent may fail again and trigger it anew.
type SystemctlManager struct {
	// Systemctl runs systemctl; nil runs the real one.
	Systemctl func(args ...string) error
}

func (m SystemctlManager) run(args ...string) error {
	if m.Systemctl == nil {
		return Systemctl(args...)
	}
	return m.Systemctl(args...)
}

// Start implements ServiceManager.
func (m SystemctlManager) Start(name string) error { return m.run("start", "--no-block", name) }

// Restart implements ServiceManager.
func (m SystemctlManager) Restart(name string) error { return m.run("restart", "--no-block", name) }

// ResetFailed implements ServiceManager: it clears the start limit.
func (m SystemctlManager) ResetFailed(name string) error { return m.run("reset-failed", name) }

// systemctlTimeout bounds one systemctl call.
const systemctlTimeout = time.Minute

// Systemctl runs systemctl with args and returns its output in the error.
func Systemctl(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), systemctlTimeout)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "systemctl", args...)
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(out.String()))
	}
	return nil
}
