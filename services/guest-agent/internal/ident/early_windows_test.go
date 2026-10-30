package ident

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestSetupNotInProgressOnInstalledSystem(t *testing.T) {
	if SetupInProgress() {
		t.Error("SetupInProgress = true on a finished installation")
	}
}

func TestIdentityMutexSerializes(t *testing.T) {
	unlock, err := lockIdentity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		defer cancel()
		u, err := lockIdentity(ctx)
		if err == nil {
			u()
		}
		got <- err
	}()
	if err := <-got; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second lock while held: %v, want deadline exceeded", err)
	}
	unlock()

	u, err := lockIdentity(context.Background())
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	u()
}

func TestSecureSSHFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "ssh_host_ed25519_key")
	if err := os.WriteFile(p, []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := secureSSHFile(p); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		t.Fatal(err)
	}
	if !owner.IsWellKnown(windows.WinLocalSystemSid) {
		t.Errorf("owner = %s, want SYSTEM", owner)
	}
	ctl, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if ctl&windows.SE_DACL_PROTECTED == 0 {
		t.Error("DACL is not protected")
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]windows.ACCESS_MASK{}
	for i := range uint32(dacl.AceCount) {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			t.Fatalf("ACE %d has type %d", i, ace.Header.AceType)
		}
		got[(*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()] |= ace.Mask
	}
	const fileAllAccess = 0x1f01ff
	want := map[string]windows.ACCESS_MASK{"S-1-5-18": fileAllAccess, "S-1-5-32-544": fileAllAccess}
	if !maps.Equal(got, want) {
		t.Errorf("DACL = %v, want only SYSTEM and Administrators with full control", got)
	}
}

func TestUTF16LEMatchesWindows(t *testing.T) {
	pw := []byte("pässwörd-1")
	u, err := windows.UTF16FromString(string(pw))
	if err != nil {
		t.Fatal(err)
	}
	u = u[:len(u)-1]
	got := utf16LE(pw)
	if len(got) != 2*len(u) {
		t.Fatalf("len = %d, want %d", len(got), 2*len(u))
	}
	for i, c := range u {
		if got[2*i] != byte(c) || got[2*i+1] != byte(c>>8) {
			t.Fatalf("mismatch at %d", i)
		}
	}
}
