package agent

import (
	"runtime"
	"slices"
	"testing"
)

// TestCapabilityWipeSecrets: only the Windows agent announces
// system.quiesce.wipe_secrets.v1 (S9 spec 12.10).
func TestCapabilityWipeSecrets(t *testing.T) {
	caps := capabilityList()
	if got, want := slices.Contains(caps, CapQuiesceWipeSecrets), runtime.GOOS == "windows"; got != want {
		t.Errorf("%s announced = %v on %s, want %v", CapQuiesceWipeSecrets, got, runtime.GOOS, want)
	}
	if !slices.Contains(caps, "system.quiesce.v1") {
		t.Error("system.quiesce.v1 missing")
	}
	// The list is a copy.
	caps[0] = "changed"
	if capabilityList()[0] == "changed" {
		t.Error("capabilityList shares its slice")
	}
}
