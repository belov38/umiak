//go:build linux

package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	sddbus "github.com/coreos/go-systemd/v22/dbus"
	"github.com/godbus/dbus/v5"
)

// D-Bus error names of the systemd manager.
const (
	dbusErrUnitExists  = "org.freedesktop.systemd1.UnitExists"
	dbusErrNoSuchUnit  = "org.freedesktop.systemd1.NoSuchUnit"
	jobResultDone      = "done"
	unitResultFallback = "unknown"
)

// commandEnv keeps the shim small: it holds pipes and a socket, nothing
// else (spec section 9.7).
var commandEnv = []string{"GOGC=50", "GOMEMLIMIT=6MiB"}

// systemd is the Supervisor on a systemd host.
type systemd struct {
	conn       *sddbus.Conn
	slice      string
	cgroupRoot string
}

// NewSystemd connects to systemd over the system bus. Command units go into
// slice (DefaultSlice in production); cgroupRoot is the cgroup v2 mount
// (DefaultCgroupRoot).
func NewSystemd(slice string, cgroupRoot string) (Supervisor, error) {
	// godbus closes the connection when this context ends, so it must
	// live as long as the supervisor.
	conn, err := sddbus.NewSystemConnectionContext(context.Background())
	if err != nil {
		return nil, fmt.Errorf("supervisor: connect to systemd: %w", err)
	}
	return &systemd{conn: conn, slice: slice, cgroupRoot: cgroupRoot}, nil
}

// Launch implements Supervisor. With Type=notify the start job completes
// only after the shim's READY=1, or fails when the shim exits before it.
func (s *systemd) Launch(ctx context.Context, id string, shimPath string, extraArgs []string) error {
	if err := checkCommandID(id); err != nil {
		return err
	}
	name := UnitName(id)
	props := []sddbus.Property{
		sddbus.PropDescription("sbx command " + id),
		sddbus.PropExecStart(shimArgv(id, shimPath, extraArgs), false),
		sddbus.PropType("notify"),
		{Name: "NotifyAccess", Value: dbus.MakeVariant("main")},
		sddbus.PropSlice(s.slice),
		{Name: "Delegate", Value: dbus.MakeVariant(true)},
		{Name: "KillMode", Value: dbus.MakeVariant("control-group")},
		{Name: "CollectMode", Value: dbus.MakeVariant("inactive-or-failed")},
		{Name: "Environment", Value: dbus.MakeVariant(commandEnv)},
	}
	return s.startTransient(ctx, name, props)
}

// StartWatchdog implements Supervisor.
func (s *systemd) StartWatchdog(ctx context.Context, leaseID string, argv []string) error {
	if err := checkLeaseID(leaseID); err != nil {
		return err
	}
	if len(argv) == 0 {
		return errors.New("supervisor: empty watchdog argv")
	}
	props := []sddbus.Property{
		sddbus.PropDescription("sbx quiesce watchdog " + leaseID),
		sddbus.PropExecStart(argv, false),
		sddbus.PropType("simple"),
		{Name: "CollectMode", Value: dbus.MakeVariant("inactive-or-failed")},
	}
	return s.startTransient(ctx, WatchdogUnitName(leaseID), props)
}

// startTransient creates and starts a transient unit in mode "fail" and
// waits for its start job.
func (s *systemd) startTransient(ctx context.Context, name string, props []sddbus.Property) error {
	// Buffered: go-systemd blocks its signal dispatch until the result is
	// taken, and an expired ctx never takes it.
	ch := make(chan string, 1)
	if _, err := s.conn.StartTransientUnitContext(ctx, name, "fail", props, ch); err != nil {
		if dbusErrName(err) == dbusErrUnitExists {
			return fmt.Errorf("%w: %s", ErrUnitExists, name)
		}
		return fmt.Errorf("supervisor: start %s: %w", name, err)
	}
	select {
	case res := <-ch:
		if res == jobResultDone {
			return nil
		}
		return fmt.Errorf("supervisor: start %s: job %s, unit result %s", name, res, s.unitResult(ctx, name))
	case <-ctx.Done():
		return ctx.Err()
	}
}

// unitResult returns the service Result of name for an error message. A
// failed transient unit may already be collected; then it is unknown.
func (s *systemd) unitResult(ctx context.Context, name string) string {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	p, err := s.conn.GetUnitTypePropertyContext(ctx, name, "Service", "Result")
	if err != nil {
		return unitResultFallback
	}
	// A collected unit reads as a fresh stub with Result "success", which
	// says nothing about a failed job.
	if v, ok := p.Value.Value().(string); ok && v != "" && v != "success" {
		return v
	}
	return unitResultFallback
}

// State implements Supervisor.
func (s *systemd) State(ctx context.Context, id string) (UnitState, error) {
	if err := checkCommandID(id); err != nil {
		return UnitNotFound, err
	}
	st, err := s.conn.ListUnitsByNamesContext(ctx, []string{UnitName(id)})
	if err != nil {
		return UnitNotFound, fmt.Errorf("supervisor: state of %s: %w", UnitName(id), err)
	}
	if len(st) == 0 {
		return UnitNotFound, nil
	}
	return unitState(st[0].LoadState, st[0].ActiveState), nil
}

// unitState maps systemd's load and active states.
func unitState(load, active string) UnitState {
	if load == "not-found" || load == "" {
		return UnitNotFound
	}
	switch active {
	case "active", "activating", "deactivating", "reloading", "refreshing":
		return UnitActive
	default: // inactive, failed, maintenance
		return UnitInactive
	}
}

// KillCgroup implements Supervisor.
func (s *systemd) KillCgroup(ctx context.Context, id string) error {
	if err := checkCommandID(id); err != nil {
		return err
	}
	name := UnitName(id)
	p, err := s.conn.GetUnitTypePropertyContext(ctx, name, "Service", "ControlGroup")
	if err != nil {
		if dbusErrName(err) == dbusErrNoSuchUnit {
			return fmt.Errorf("%w: %s", ErrUnitNotFound, name)
		}
		return fmt.Errorf("supervisor: cgroup of %s: %w", name, err)
	}
	cg, _ := p.Value.Value().(string)
	if cg == "" {
		return fmt.Errorf("%w: %s has no cgroup", ErrUnitNotFound, name)
	}
	path := filepath.Join(s.cgroupRoot, cg, "payload", "cgroup.kill")
	if err := os.WriteFile(path, []byte("1"), 0); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%w: %s: %w", ErrUnitNotFound, name, err)
		}
		return fmt.Errorf("supervisor: kill %s: %w", name, err)
	}
	return nil
}

// Stop implements Supervisor.
func (s *systemd) Stop(ctx context.Context, id string) error {
	if err := checkCommandID(id); err != nil {
		return err
	}
	return s.stop(ctx, UnitName(id))
}

// StopWatchdog implements Supervisor.
func (s *systemd) StopWatchdog(ctx context.Context, leaseID string) error {
	if err := checkLeaseID(leaseID); err != nil {
		return err
	}
	return s.stop(ctx, WatchdogUnitName(leaseID))
}

// stop stops name and waits for the job; a unit that is not loaded is
// already stopped.
func (s *systemd) stop(ctx context.Context, name string) error {
	ch := make(chan string, 1)
	if _, err := s.conn.StopUnitContext(ctx, name, "replace", ch); err != nil {
		if dbusErrName(err) == dbusErrNoSuchUnit {
			return nil
		}
		return fmt.Errorf("supervisor: stop %s: %w", name, err)
	}
	select {
	case res := <-ch:
		if res == jobResultDone {
			return nil
		}
		return fmt.Errorf("supervisor: stop %s: job %s", name, res)
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close implements Supervisor.
func (s *systemd) Close() error {
	s.conn.Close()
	return nil
}

// dbusErrName returns the D-Bus error name of err, or "".
func dbusErrName(err error) string {
	var e dbus.Error
	if errors.As(err, &e) {
		return e.Name
	}
	var pe *dbus.Error
	if errors.As(err, &pe) {
		return pe.Name
	}
	return ""
}
