package agent

import (
	"context"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TestSecureSocketACL opens an admin socket and reads its DACL back: SYSTEM
// and Administrators only, nothing inherited from the directory.
func TestSecureSocketACL(t *testing.T) {
	p := filepath.Join(t.TempDir(), "admin.sock")
	ln, err := listenLocal(context.Background(), p, socketAdmin, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	s := sd.String()
	if !strings.Contains(s, "D:P") || !strings.Contains(s, ";;;SY)") || !strings.Contains(s, ";;;BA)") {
		t.Errorf("socket DACL = %s, want protected SYSTEM and Administrators", s)
	}
	if strings.Contains(s, ";;;BU)") || strings.Contains(s, ";;;WD)") || strings.Contains(s, ";;;AU)") {
		t.Errorf("socket DACL = %s grants users", s)
	}
	// The test runs elevated (SYSTEM or an administrator): it can connect.
	var d net.Dialer
	c, err := d.DialContext(context.Background(), "unix", p)
	if err != nil {
		t.Fatalf("connect as administrator: %v", err)
	}
	_ = c.Close()
}

// TestEnvSocketUserACE opens an env socket for an account (BUILTIN\Users
// stands in for the default user, it exists on every machine) and finds an
// ACE that lets it read and write the socket.
func TestEnvSocketUserACE(t *testing.T) {
	p := filepath.Join(t.TempDir(), "env.sock")
	ln, err := listenLocal(context.Background(), p, socketEnv, "Users")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	users, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatal(err)
	}
	const rw = windows.FILE_GENERIC_READ | windows.FILE_GENERIC_WRITE
	found := false
	for i := range uint32(dacl.AceCount) {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if sid.Equals(users) && uint32(ace.Mask)&rw == rw {
			found = true
		}
	}
	if !found {
		t.Errorf("env socket DACL %s has no read/write ACE for the account", sd.String())
	}
}
