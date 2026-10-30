package winapi

import (
	"os"
	"strings"
	"testing"
)

func TestQueryProcessSelf(t *testing.T) {
	info, err := QueryProcess(uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	if want := exe[strings.LastIndexByte(exe, '\\')+1:]; !strings.EqualFold(info.Name, want) {
		t.Errorf("name = %q, want %q", info.Name, want)
	}
	if info.User == "" || strings.Contains(info.User, `\`) {
		t.Errorf("user = %q, want an account name without domain", info.User)
	}
}

func TestQueryProcessSystem(t *testing.T) {
	info, err := QueryProcess(4)
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "System" {
		t.Errorf("name = %q, want System", info.Name)
	}
}

func TestQueryProcessMissing(t *testing.T) {
	if _, err := QueryProcess(0xFFFFFFF0); err == nil {
		t.Fatal("expected an error for a pid that does not exist")
	}
}

func TestExtendedTCPListenersFamilies(t *testing.T) {
	for _, af := range []uint32{AFInet, AFInet6} {
		b, err := ExtendedTCPListeners(af)
		if err != nil {
			t.Fatalf("family %d: %v", af, err)
		}
		if len(b) < 4 {
			t.Fatalf("family %d: %d bytes", af, len(b))
		}
	}
	if err := procGetExtendedTCPTable.Find(); err != nil {
		t.Fatal(err)
	}
}
