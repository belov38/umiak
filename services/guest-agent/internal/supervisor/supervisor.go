// Package supervisor starts command shims and quiesce watchdogs as transient
// systemd units (spec sections 9.2, 9.3 and 14.2). The systemd implementation
// talks to systemd over D-Bus; Fake runs everything in process for tests.
package supervisor

import (
	"context"
	"errors"
	"fmt"
)

// DefaultSlice is the slice of the command units.
const DefaultSlice = "sbx-cmd.slice"

// DefaultCgroupRoot is the cgroup v2 mount point.
const DefaultCgroupRoot = "/sys/fs/cgroup"

// Unit name prefixes and suffix.
const (
	cmdUnitPrefix      = "sbx-cmd-"
	watchdogUnitPrefix = "sbx-quiesce-watchdog-"
	serviceSuffix      = ".service"
	// maxUnitName is the longest unit name systemd accepts.
	maxUnitName = 255
)

// ErrUnitExists is returned by Launch and StartWatchdog when a unit with the
// same name is still loaded: systemd never runs two units of one name, which
// makes a repeated start of a command safe.
var ErrUnitExists = errors.New("supervisor: unit already exists")

// ErrUnitNotFound is returned by KillCgroup when the unit is gone or has no
// cgroup.
var ErrUnitNotFound = errors.New("supervisor: unit not found")

// UnitState is the coarse state of a command unit.
type UnitState int

// Unit states.
const (
	// UnitNotFound: no such unit (never started, or exited and collected).
	UnitNotFound UnitState = iota
	// UnitActive: the unit runs (starting, running or stopping), so the
	// shim or the command may still be alive.
	UnitActive
	// UnitInactive: the unit is loaded but stopped or failed.
	UnitInactive
)

// String implements fmt.Stringer.
func (s UnitState) String() string {
	switch s {
	case UnitNotFound:
		return "not-found"
	case UnitActive:
		return "active"
	case UnitInactive:
		return "inactive"
	default:
		return fmt.Sprintf("UnitState(%d)", int(s))
	}
}

// Supervisor runs command shims and quiesce watchdogs.
type Supervisor interface {
	// Launch starts sbx-cmd-<id>.service running
	// `shimPath shim --id <id> extraArgs...` and returns once the shim sent
	// READY=1 (the command started or its start failure is recorded) or the
	// unit failed. It returns ErrUnitExists if the unit is still loaded.
	Launch(ctx context.Context, id string, shimPath string, extraArgs []string) error
	// State returns the state of the unit of command id.
	State(ctx context.Context, id string) (UnitState, error)
	// KillCgroup kills the payload cgroup of command id (cgroup.kill), for a
	// shim that cannot be reached. It returns ErrUnitNotFound if the unit is
	// gone.
	KillCgroup(ctx context.Context, id string) error
	// Stop stops the unit of command id and everything in it. It is meant
	// for cleanup only; a missing unit is not an error.
	Stop(ctx context.Context, id string) error
	// StartWatchdog starts sbx-quiesce-watchdog-<leaseID>.service running
	// argv. It returns ErrUnitExists if the unit is still loaded.
	StartWatchdog(ctx context.Context, leaseID string, argv []string) error
	// StopWatchdog stops the watchdog unit of leaseID; a missing unit is
	// not an error.
	StopWatchdog(ctx context.Context, leaseID string) error
	// Close releases the connection to systemd.
	Close() error
}

// UnitName returns the unit name of command id.
func UnitName(id string) string {
	return cmdUnitPrefix + id + serviceSuffix
}

// WatchdogUnitName returns the unit name of the watchdog of leaseID.
func WatchdogUnitName(leaseID string) string {
	return watchdogUnitPrefix + leaseID + serviceSuffix
}

// checkCommandID rejects a command id that would not form a valid unit name.
func checkCommandID(id string) error {
	return checkNamePart("command id", id, len(cmdUnitPrefix)+len(serviceSuffix))
}

// checkLeaseID rejects a lease id that would not form a valid unit name.
func checkLeaseID(id string) error {
	return checkNamePart("lease id", id, len(watchdogUnitPrefix)+len(serviceSuffix))
}

// checkNamePart accepts the bytes systemd allows in a unit name without
// escaping, [A-Za-z0-9:_.-], up to the unit name limit. The id appears in
// the unit name and the cgroup path unchanged.
func checkNamePart(what, id string, overhead int) error {
	if id == "" || len(id)+overhead > maxUnitName {
		return fmt.Errorf("supervisor: %s must be 1..%d bytes", what, maxUnitName-overhead)
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == ':', c == '_', c == '.', c == '-':
		default:
			return fmt.Errorf("supervisor: %s %q must match [A-Za-z0-9:_.-]", what, id)
		}
	}
	return nil
}

// shimArgv is the command line of the shim of command id.
func shimArgv(id, shimPath string, extraArgs []string) []string {
	argv := make([]string, 0, 4+len(extraArgs))
	argv = append(argv, shimPath, "shim", "--id", id)
	return append(argv, extraArgs...)
}
