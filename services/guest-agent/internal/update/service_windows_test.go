package update

import (
	"crypto/ed25519"
	"errors"
	"os"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// TestInstallCreatesServiceConfig installs a package with the service under
// a throwaway name and checks the service configuration; the service is
// never started. Needs administrator rights (the agent tests run as SYSTEM);
// without them it fails unless SBX_TEST_ALLOW_SKIP=1.
func TestInstallCreatesServiceConfig(t *testing.T) {
	m, err := mgr.Connect()
	if err != nil {
		if os.Getenv("SBX_TEST_ALLOW_SKIP") == "1" {
			t.Skipf("no access to the service manager: %v", err)
		}
		t.Fatalf("no access to the service manager (run as an administrator, or set SBX_TEST_ALLOW_SKIP=1): %v", err)
	}
	_ = m.Disconnect()
	pub, priv := testKey(t)
	l := paths.ForRoot(t.TempDir())
	name := "sbx-agent-test-" + randHex()
	t.Cleanup(func() { deleteTestService(t, name) })

	opts := InstallOptions{Activate: true, InstallUnits: true, ServiceName: name}
	if _, err := Install(l, packTest(t, "v1", priv), []ed25519.PublicKey{pub}, opts); err != nil {
		t.Fatal(err)
	}
	check := func() {
		t.Helper()
		c, err := CheckService(l, name)
		if err != nil {
			t.Fatal(err)
		}
		if len(c.Problems) != 0 {
			t.Errorf("problems: %v", c.Problems)
		}
		if c.State != "stopped" {
			t.Errorf("state = %q, want stopped (install must not start it)", c.State)
		}
	}
	check()
	err = withService(name, func(s *mgr.Service) error {
		c, err := s.Config()
		if err != nil {
			return err
		}
		if c.ServiceStartName != serviceAccount || c.StartType != mgr.StartAutomatic || c.DelayedAutoStart {
			t.Errorf("config = %+v", c)
		}
		// Break a setting; the next install repairs it.
		c.DelayedAutoStart = true
		return s.UpdateConfig(c)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Install(l, packTest(t, "v2", priv), []ed25519.PublicKey{pub}, opts); err != nil {
		t.Fatal(err)
	}
	check()
	if got := ServiceState(name); got != "stopped" {
		t.Errorf("ServiceState = %q", got)
	}
	if got := ServiceState(name + "-missing"); got != "not-found" {
		t.Errorf("ServiceState of a missing service = %q", got)
	}
}

func deleteTestService(t *testing.T, name string) {
	t.Helper()
	err := withService(name, func(s *mgr.Service) error { return s.Delete() })
	if err != nil && !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		t.Errorf("delete service %s: %v", name, err)
	}
}
