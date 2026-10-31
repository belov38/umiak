package fsutil

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestMkdirSecureDACL(t *testing.T) {
	for _, tt := range []struct {
		access DirAccess
		admins bool
	}{{SystemOnly, false}, {SystemAndAdmins, true}} {
		dir := filepath.Join(t.TempDir(), "run")
		if err := MkdirSecure(dir, tt.access); err != nil {
			t.Fatal(err)
		}
		sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		s := sd.String()
		flags, aces := splitDACL(s)
		if !strings.Contains(flags, "P") || !strings.Contains(s, ";;;SY)") || strings.Contains(s, ";;;BA)") != tt.admins {
			t.Errorf("DACL of %v = %s", tt.access, s)
		}
		if n := 1 + map[bool]int{true: 1}[tt.admins]; len(aces) != n {
			t.Errorf("DACL of %v = %s, want %d ACEs", tt.access, s, n)
		}
		// Idempotent, and a file inside inherits it.
		if err := MkdirSecure(dir, tt.access); err != nil {
			t.Fatal(err)
		}
		f := filepath.Join(dir, "x")
		if err := os.WriteFile(f, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		ok, err := TrustedOwner(f)
		if err != nil || !ok {
			t.Errorf("file written by the test (elevated) is not trusted: %v %v", ok, err)
		}
	}
}

func TestSameProtectedDACL(t *testing.T) {
	want := "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	if !sameProtectedDACL("D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)", want) {
		t.Error("same ACEs in another order")
	}
	if sameProtectedDACL("D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", want) || sameProtectedDACL("D:P(A;OICI;FA;;;SY)", want) {
		t.Error("unprotected or missing ACE accepted")
	}
}
