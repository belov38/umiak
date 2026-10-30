package winapi

import (
	"os"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestIdentityProcsResolve(t *testing.T) {
	for _, p := range []*windows.LazyProc{procSetComputerNameExW, procInitiateShutdownW} {
		if err := p.Find(); err != nil {
			t.Errorf("find %s: %v", p.Name, err)
		}
	}
}

func TestGetComputerNameEx(t *testing.T) {
	name, err := GetComputerNameEx(windows.ComputerNamePhysicalDnsHostname)
	if err != nil {
		t.Fatal(err)
	}
	host, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	if name == "" || !strings.EqualFold(name, host) {
		t.Errorf("GetComputerNameEx = %q, os.Hostname = %q", name, host)
	}
}

func TestImageStateOnInstalledSystem(t *testing.T) {
	st, err := ImageState()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(st, "IMAGE_STATE_") {
		t.Errorf("ImageState = %q", st)
	}
}
