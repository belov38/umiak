package update

import (
	"errors"
	"fmt"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// AgentService is the agent service that Rollback starts.
const AgentService = "sbx-agent"

// Settings of the agent service (S9 spec 12.2).
const (
	serviceDisplayName = "sbx agent"
	serviceDescription = "Guest agent of the sbx sandbox"
	serviceAccount     = "LocalSystem"
	// PreshutdownTimeout is how long the service may take on PRESHUTDOWN.
	PreshutdownTimeout = 15 * time.Second
	// failureResetPeriod resets the failure count after this many seconds
	// without a failure.
	failureResetPeriod = 120
	// serviceWait bounds the wait for a service to stop.
	serviceWait = time.Minute
)

// failureActions are restart, restart, then the rollback command: the
// Windows form of Restart=always, StartLimitBurst and OnFailure.
var failureActions = []mgr.RecoveryAction{
	{Type: mgr.ServiceRestart, Delay: time.Second},
	{Type: mgr.ServiceRestart, Delay: time.Second},
	{Type: mgr.RunCommand, Delay: time.Second},
}

// SCMManager is the ServiceManager of the Windows service control manager.
// The failure count resets on its own after failureResetPeriod, so
// ResetFailed does nothing.
type SCMManager struct{}

// DefaultServiceManager returns the ServiceManager of this OS.
func DefaultServiceManager() ServiceManager { return SCMManager{} }

// Start implements ServiceManager. A running service is fine; a service
// that is stopping is waited for first.
func (SCMManager) Start(name string) error {
	return withService(name, func(s *mgr.Service) error {
		if err := waitStopped(s, false); err != nil {
			return err
		}
		return startService(s)
	})
}

// Restart implements ServiceManager: stop, wait until stopped, start.
func (SCMManager) Restart(name string) error {
	return withService(name, func(s *mgr.Service) error {
		if err := waitStopped(s, true); err != nil {
			return err
		}
		return startService(s)
	})
}

// ResetFailed implements ServiceManager.
func (SCMManager) ResetFailed(string) error { return nil }

func withService(name string, fn func(s *mgr.Service) error) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("update: connect to the service manager: %w", err)
	}
	defer func() { _ = m.Disconnect() }()
	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("update: open service %s: %w", name, err)
	}
	defer func() { _ = s.Close() }()
	return fn(s)
}

func startService(s *mgr.Service) error {
	err := s.Start()
	if errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("update: start service %s: %w", s.Name, err)
	}
	return nil
}

// waitStopped waits until s is stopped, sending a stop control first when
// stop is set. Without stop a running service is left alone.
func waitStopped(s *mgr.Service, stop bool) error {
	st, err := s.Query()
	if err != nil {
		return fmt.Errorf("update: query service %s: %w", s.Name, err)
	}
	if stop && st.State != svc.Stopped && st.State != svc.StopPending {
		st, err = s.Control(svc.Stop)
		if err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return fmt.Errorf("update: stop service %s: %w", s.Name, err)
		}
	}
	deadline := time.Now().Add(serviceWait)
	for st.State == svc.StopPending || (stop && st.State != svc.Stopped) {
		if time.Now().After(deadline) {
			return fmt.Errorf("update: service %s did not stop in %s", s.Name, serviceWait)
		}
		time.Sleep(250 * time.Millisecond)
		if st, err = s.Query(); err != nil {
			return fmt.Errorf("update: query service %s: %w", s.Name, err)
		}
	}
	return nil
}

// serviceCommandLine is the ImagePath of the agent service.
func serviceCommandLine(l paths.Layout) string {
	return syscall.EscapeArg(filepath.Join(l.CurrentLink, BinaryName)) + " run"
}

// recoveryCommand is the run-command failure action: `rollback` of the
// previous version, or of the current one when there is no previous. The
// choice is made when the command runs, like sbx-agent-rollback.service.
func recoveryCommand(l paths.Layout) (string, error) {
	sys, err := windows.GetSystemDirectory()
	if err != nil {
		return "", err
	}
	prev := filepath.Join(l.PreviousLink, BinaryName)
	cur := filepath.Join(l.CurrentLink, BinaryName)
	return fmt.Sprintf(`"%s" /d /c if exist "%s" ("%s" rollback) else ("%s" rollback)`,
		filepath.Join(sys, "cmd.exe"), prev, prev, cur), nil
}

// installService creates or updates the agent service (S9 spec 12.2):
// LocalSystem, automatic start (not delayed), ImagePath
// `"<current>\sbx-agent.exe" run`, failure actions with the rollback
// command, failure actions also on non-crash failures, a 15 s preshutdown
// timeout. It does not start the service: an image build VM must never run
// the agent before sysprep. With SystemPath it adds current to the system
// Path.
func installService(l paths.Layout, opts InstallOptions) error {
	name := opts.ServiceName
	if name == "" {
		name = AgentService
	}
	cmd, err := recoveryCommand(l)
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("update: connect to the service manager: %w", err)
	}
	defer func() { _ = m.Disconnect() }()

	s, err := m.OpenService(name)
	switch {
	case errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST):
		s, err = m.CreateService(name, filepath.Join(l.CurrentLink, BinaryName), mgr.Config{
			StartType:        mgr.StartAutomatic,
			ErrorControl:     mgr.ErrorNormal,
			ServiceStartName: serviceAccount,
			DisplayName:      serviceDisplayName,
			Description:      serviceDescription,
		}, "run")
		if err != nil {
			return fmt.Errorf("update: create service %s: %w", name, err)
		}
	case err != nil:
		return fmt.Errorf("update: open service %s: %w", name, err)
	default:
		c, err := s.Config()
		if err != nil {
			_ = s.Close()
			return fmt.Errorf("update: read service %s: %w", name, err)
		}
		c.StartType = mgr.StartAutomatic
		c.DelayedAutoStart = false
		c.ErrorControl = mgr.ErrorNormal
		c.BinaryPathName = serviceCommandLine(l)
		c.ServiceStartName = serviceAccount
		c.Password = ""
		c.DisplayName = serviceDisplayName
		c.Description = serviceDescription
		if err := s.UpdateConfig(c); err != nil {
			_ = s.Close()
			return fmt.Errorf("update: update service %s: %w", name, err)
		}
	}
	defer func() { _ = s.Close() }()

	if err := s.SetRecoveryActions(failureActions, failureResetPeriod); err != nil {
		return fmt.Errorf("update: service %s failure actions: %w", name, err)
	}
	if err := s.SetRecoveryCommand(cmd); err != nil {
		return fmt.Errorf("update: service %s rollback command: %w", name, err)
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return fmt.Errorf("update: service %s failure actions flag: %w", name, err)
	}
	if err := setPreshutdownTimeout(s.Handle, PreshutdownTimeout); err != nil {
		return fmt.Errorf("update: service %s preshutdown timeout: %w", name, err)
	}
	if opts.SystemPath {
		if err := addToSystemPath(l.CurrentLink); err != nil {
			return err
		}
	}
	return nil
}

// servicePreshutdownInfo is SERVICE_PRESHUTDOWN_INFO.
type servicePreshutdownInfo struct {
	PreshutdownTimeout uint32
}

func setPreshutdownTimeout(h windows.Handle, d time.Duration) error {
	info := servicePreshutdownInfo{PreshutdownTimeout: uint32(d.Milliseconds())}
	return windows.ChangeServiceConfig2(h, windows.SERVICE_CONFIG_PRESHUTDOWN_INFO, (*byte)(unsafe.Pointer(&info)))
}

func preshutdownTimeout(h windows.Handle) (time.Duration, error) {
	var info servicePreshutdownInfo
	var n uint32
	if err := windows.QueryServiceConfig2(h, windows.SERVICE_CONFIG_PRESHUTDOWN_INFO,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), &n); err != nil {
		return 0, err
	}
	return time.Duration(info.PreshutdownTimeout) * time.Millisecond, nil
}

// ServiceCheck is the state and configuration of the agent service, for
// doctor.
type ServiceCheck struct {
	// State is running, stopped, start_pending and so on.
	State string
	// Problems lists the settings that differ from what install-package
	// configures; empty when the service is configured.
	Problems []string
}

// CheckService reports the state of service name and compares its
// configuration with installService for layout l.
func CheckService(l paths.Layout, name string) (*ServiceCheck, error) {
	var out ServiceCheck
	err := withService(name, func(s *mgr.Service) error {
		st, err := s.Query()
		if err != nil {
			return err
		}
		out.State = StateName(st.State)
		c, err := s.Config()
		if err != nil {
			return err
		}
		bad := func(format string, args ...any) { out.Problems = append(out.Problems, fmt.Sprintf(format, args...)) }
		if c.StartType != mgr.StartAutomatic || c.DelayedAutoStart {
			bad("start type %d (delayed %t), want automatic", c.StartType, c.DelayedAutoStart)
		}
		if want := serviceCommandLine(l); c.BinaryPathName != want {
			bad("image path %q, want %q", c.BinaryPathName, want)
		}
		actions, err := s.RecoveryActions()
		if err != nil {
			return err
		}
		if !sameActions(actions, failureActions) {
			bad("failure actions %v, want %v", actions, failureActions)
		}
		if p, err := s.ResetPeriod(); err != nil {
			return err
		} else if p != failureResetPeriod {
			bad("failure reset period %d s, want %d s", p, failureResetPeriod)
		}
		want, err := recoveryCommand(l)
		if err != nil {
			return err
		}
		if cmd, err := s.RecoveryCommand(); err != nil {
			return err
		} else if cmd != want {
			bad("rollback command %q, want %q", cmd, want)
		}
		if on, err := s.RecoveryActionsOnNonCrashFailures(); err != nil {
			return err
		} else if !on {
			bad("failure actions on non-crash failures are off")
		}
		if d, err := preshutdownTimeout(s.Handle); err != nil {
			return err
		} else if d != PreshutdownTimeout {
			bad("preshutdown timeout %s, want %s", d, PreshutdownTimeout)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func sameActions(a, b []mgr.RecoveryAction) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// StateName names a service state like doctor reports it.
func StateName(s svc.State) string {
	switch s {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start_pending"
	case svc.StopPending:
		return "stop_pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue_pending"
	case svc.PausePending:
		return "pause_pending"
	case svc.Paused:
		return "paused"
	default:
		return fmt.Sprintf("state %d", s)
	}
}

// ServiceState returns the state of service name (StateName), "not-found"
// when it does not exist, or "unknown: <error>".
func ServiceState(name string) string {
	var state string
	err := withService(name, func(s *mgr.Service) error {
		st, err := s.Query()
		if err != nil {
			return err
		}
		state = StateName(st.State)
		return nil
	})
	switch {
	case errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST):
		return "not-found"
	case err != nil:
		return "unknown: " + err.Error()
	}
	return state
}
