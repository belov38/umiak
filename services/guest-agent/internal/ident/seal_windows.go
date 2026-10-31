package ident

import (
	"context"
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// sealServices are stopped before seal, the agent first.
var sealServices = []string{"sbx-agent", "sshd"}

// serviceStopTimeout bounds the wait for one service to stop.
const serviceStopTimeout = time.Minute

// Seal prepares the image for use as a template (S9 spec 12.11), see
// SealWindows. The secrets directory is removed without an overwrite; the
// CLI passes the overwriting wiper to SealWindows instead.
func Seal(ctx context.Context, l paths.Layout, stopAgent func() error) error {
	return SealWindows(ctx, l, stopAgent, nil)
}

// StopServices stops the sbx-agent and sshd services and waits until they
// are stopped. A missing or already stopped service counts as stopped.
func StopServices() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("ident: connect to the service manager: %w", err)
	}
	defer m.Disconnect() //nolint:errcheck // nothing to do on failure
	for _, name := range sealServices {
		if err := stopService(m, name); err != nil {
			return err
		}
	}
	return nil
}

func stopService(m *mgr.Mgr, name string) error {
	s, err := m.OpenService(name)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("ident: open service %s: %w", name, err)
	}
	defer s.Close() //nolint:errcheck // nothing to do on failure
	st, err := s.Control(svc.Stop)
	switch {
	case errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE):
		return nil
	case err != nil && !errors.Is(err, windows.ERROR_SERVICE_CANNOT_ACCEPT_CTRL):
		return fmt.Errorf("ident: stop service %s: %w", name, err)
	}
	deadline := time.Now().Add(serviceStopTimeout)
	for st.State != svc.Stopped {
		if time.Now().After(deadline) {
			return fmt.Errorf("ident: service %s did not stop in %s", name, serviceStopTimeout)
		}
		time.Sleep(250 * time.Millisecond)
		if st, err = s.Query(); err != nil {
			return fmt.Errorf("ident: query service %s: %w", name, err)
		}
	}
	return nil
}
