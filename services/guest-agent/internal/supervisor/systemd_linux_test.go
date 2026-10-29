//go:build linux

package supervisor

import (
	"errors"
	"fmt"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestUnitState(t *testing.T) {
	tests := []struct {
		load, active string
		want         UnitState
	}{
		{"not-found", "inactive", UnitNotFound},
		{"", "", UnitNotFound},
		{"loaded", "active", UnitActive},
		{"loaded", "activating", UnitActive},
		{"loaded", "deactivating", UnitActive},
		{"loaded", "inactive", UnitInactive},
		{"loaded", "failed", UnitInactive},
	}
	for _, tt := range tests {
		if got := unitState(tt.load, tt.active); got != tt.want {
			t.Errorf("unitState(%q, %q) = %v, want %v", tt.load, tt.active, got, tt.want)
		}
	}
}

func TestDBusErrName(t *testing.T) {
	tests := []struct {
		err  error
		want string
	}{
		{dbus.Error{Name: dbusErrUnitExists}, dbusErrUnitExists},
		{&dbus.Error{Name: dbusErrNoSuchUnit}, dbusErrNoSuchUnit},
		{fmt.Errorf("wrapped: %w", dbus.Error{Name: dbusErrUnitExists}), dbusErrUnitExists},
		{errors.New("plain"), ""},
	}
	for _, tt := range tests {
		if got := dbusErrName(tt.err); got != tt.want {
			t.Errorf("dbusErrName(%v) = %q, want %q", tt.err, got, tt.want)
		}
	}
}
