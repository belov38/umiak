package agent

import (
	"context"
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

// sshdService is the OpenSSH server service (Manual start, S9 spec 8.3).
const sshdService = "sshd"

// defaultStartSSH starts sshd through the service control manager; a
// running service is fine.
func defaultStartSSH(context.Context) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to the service manager: %w", err)
	}
	defer func() { _ = m.Disconnect() }()
	s, err := m.OpenService(sshdService)
	if err != nil {
		return fmt.Errorf("open service %s: %w", sshdService, err)
	}
	defer func() { _ = s.Close() }()
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return fmt.Errorf("start service %s: %w", sshdService, err)
	}
	return nil
}
