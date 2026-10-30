package ident

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"unicode"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

const testComputerName = "SBX0C1D2E3F4A5B"

// winLayout returns a layout under a temporary root with the Windows-only
// fields filled in (the darwin layout leaves them empty).
func winLayout(t *testing.T) paths.Layout {
	t.Helper()
	root := t.TempDir()
	l := paths.ForRoot(root)
	l.SysprepUnattend = filepath.Join(root, "Windows", "System32", "Sysprep", "sbx-unattend.xml")
	l.EarlyFile = filepath.Join(l.RunDir, "early.json")
	l.AdminSocket = filepath.Join(l.RunDir, "admin.sock")
	l.EnvSocket = filepath.Join(l.RunDir, "env.sock")
	l.SbxEnvFile = ""
	return l
}

// newWinFake returns a resetter whose RegenerateHostKeys writes one host key
// like ssh-keygen -A, and whose active computer name is active.
func newWinFake(t *testing.T, l paths.Layout, active string) *FakeWinResetter {
	t.Helper()
	return &FakeWinResetter{Active: active, OnRegenerate: func() error {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		sp, err := ssh.NewPublicKey(pub)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(l.SSHDir, 0o755); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(l.SSHDir, "ssh_host_ed25519_key.pub"), ssh.MarshalAuthorizedKey(sp), 0o644)
	}}
}

// methods returns the method names of calls without their arguments.
func methods(calls []string) []string {
	out := make([]string, 0, len(calls))
	for _, c := range calls {
		name, _, _ := strings.Cut(c, " ")
		out = append(out, name)
	}
	return out
}

func TestComputerNameFromMachineID(t *testing.T) {
	for in, want := range map[string]string{
		"0190a1b2-c3d4-7e5f-8a9b-0123456789ab": "SBX0123456789AB",
		"0190A1B2C3D47E5F8A9B0C1D2E3F4A5B":     testComputerName,
	} {
		if got := WindowsComputerName(in); got != want {
			t.Errorf("WindowsComputerName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestApplyFirstBootChangesPassword(t *testing.T) {
	l := winLayout(t)
	mustWrite(t, l.StateDB, "db")
	mustWrite(t, filepath.Join(l.CommandsDir, "c1", "stdout"), "out")
	mustWrite(t, filepath.Join(l.SSHDir, "ssh_host_rsa_key"), "template key")
	mustWrite(t, l.SysprepUnattend, "<unattend/>")
	mustWrite(t, l.TemplateSSHCA, "ssh-ed25519 AAAA template-ca\n")
	mustWrite(t, l.SSHUserCA, "ssh-ed25519 AAAA claimed-ca\n")
	r := newWinFake(t, l, "WIN-TEMPLATE")

	changed, reboot, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || !reboot {
		t.Errorf("changed, reboot = %v, %v; want true, true", changed, reboot)
	}
	want := []string{"WipeSecrets", "SetMachineGUID", "RegenerateHostKeys", "SetComputerName", "NewUserPassword", "ActiveComputerName"}
	if got := methods(r.Calls); !slices.Equal(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
	if !slices.Contains(r.Calls, "SetMachineGUID "+testMachineID) {
		t.Errorf("MachineGuid not set to the machine id: %v", r.Calls)
	}
	if !slices.Contains(r.Calls, "SetComputerName "+testComputerName) {
		t.Errorf("computer name not set: %v", r.Calls)
	}
	if !slices.Contains(r.Calls, "NewUserPassword user") {
		t.Errorf("password of user not changed: %v", r.Calls)
	}
	mustNotExist(t, l.StateDB)
	mustNotExist(t, l.CommandsDir)
	mustNotExist(t, l.SysprepUnattend)
	if got := mustRead(t, l.SSHUserCA); got != "ssh-ed25519 AAAA template-ca\n" {
		t.Errorf("sbx_user_ca.pub = %q, want the template copy", got)
	}
	f, err := LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if f.MachineID != testMachineID || !f.ResetPending || len(f.HostKeyFingerprints) != 1 {
		t.Errorf("identity.json = %+v", f)
	}
}

func TestApplyForkKeepsPassword(t *testing.T) {
	l := winLayout(t)
	if err := (&File{MachineID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	r := newWinFake(t, l, "SBXEEEEEEEEEEEE")
	changed, reboot, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly)
	if err != nil {
		t.Fatal(err)
	}
	if !changed || !reboot {
		t.Errorf("changed, reboot = %v, %v; want true, true", changed, reboot)
	}
	if slices.Contains(methods(r.Calls), "NewUserPassword") {
		t.Errorf("a fork changed the password: %v", r.Calls)
	}
	f, err := LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if f.MachineID != testMachineID || !f.ResetPending {
		t.Errorf("identity.json = %+v", f)
	}
}

func TestApplyUnreadableIdentityKeepsPassword(t *testing.T) {
	l := winLayout(t)
	mustWrite(t, l.IdentityFile, "{not json")
	r := newWinFake(t, l, testComputerName)
	if _, _, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(methods(r.Calls), "NewUserPassword") {
		t.Errorf("an unreadable identity.json changed the password: %v", r.Calls)
	}
}

func TestApplySameIDNoop(t *testing.T) {
	l := winLayout(t)
	mustWrite(t, l.StateDB, "db")
	mustWrite(t, l.SysprepUnattend, "<unattend/>")
	if err := (&File{MachineID: testMachineID}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	r := newWinFake(t, l, strings.ToLower(testComputerName))
	changed, reboot, err := ApplyWindows(context.Background(), l, testIdentity(strings.ToUpper(testMachineID)), r, ModeEarly)
	if err != nil {
		t.Fatal(err)
	}
	if changed || reboot {
		t.Errorf("changed, reboot = %v, %v; want false, false", changed, reboot)
	}
	if got := methods(r.Calls); !slices.Equal(got, []string{"ActiveComputerName"}) {
		t.Errorf("calls = %v, want only ActiveComputerName", got)
	}
	if mustRead(t, l.StateDB) != "db" {
		t.Error("state was wiped")
	}
	f, err := LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if f.ResetPending {
		t.Error("ResetPending was set by a no-op")
	}
}

func TestApplyRebootOnlyOutsideSpecialize(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mode   ApplyMode
		active string
		want   bool
	}{
		{"specialize", ModeSpecialize, "WIN-TEMPLATE", false},
		{"early", ModeEarly, "WIN-TEMPLATE", true},
		{"service", ModeService, "WIN-TEMPLATE", true},
		{"early name already active", ModeEarly, testComputerName, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := winLayout(t)
			r := newWinFake(t, l, tc.active)
			_, reboot, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, tc.mode)
			if err != nil {
				t.Fatal(err)
			}
			if reboot != tc.want {
				t.Errorf("reboot = %v, want %v", reboot, tc.want)
			}
			if slices.Contains(methods(r.Calls), "Reboot") {
				t.Error("ApplyWindows rebooted itself")
			}
		})
	}

	// A name change still pending after the apply was saved (the reboot
	// did not happen) asks for the reboot again.
	l := winLayout(t)
	if err := (&File{MachineID: testMachineID}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	r := newWinFake(t, l, "WIN-TEMPLATE")
	changed, reboot, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeService)
	if err != nil {
		t.Fatal(err)
	}
	if changed || !reboot {
		t.Errorf("pending rename: changed, reboot = %v, %v; want false, true", changed, reboot)
	}
	if got := methods(r.Calls); !slices.Equal(got, []string{"ActiveComputerName", "SetComputerName"}) {
		t.Errorf("pending rename: calls = %v, want the name set again", got)
	}
}

func TestApplyRenameRebootsBounded(t *testing.T) {
	l := winLayout(t)
	if err := (&File{MachineID: testMachineID, ResetPending: true}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	// Something keeps the old name in effect: two reboots, then none.
	r := newWinFake(t, l, "WIN-TEMPLATE")
	for i, want := range []bool{true, true, false, false} {
		_, reboot, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly)
		if err != nil {
			t.Fatal(err)
		}
		if reboot != want {
			t.Errorf("boot %d: reboot = %v, want %v", i+1, reboot, want)
		}
	}
	f, err := LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if f.RenameReboots != MaxRenameReboots || !f.ResetPending {
		t.Errorf("identity.json = %+v, want %d rename reboots and ResetPending kept", f, MaxRenameReboots)
	}

	// The name takes effect: the counter goes back to zero.
	r.Active = testComputerName
	if _, reboot, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly); err != nil || reboot {
		t.Fatalf("reboot = %v, err = %v", reboot, err)
	}
	if f, err := LoadFile(l.IdentityFile); err != nil || f.RenameReboots != 0 {
		t.Errorf("identity.json = %+v, %v; want the counter reset", f, err)
	}
}

func TestApplyInterruptedForkKeepsPassword(t *testing.T) {
	l := winLayout(t)
	if err := (&File{MachineID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	r := newWinFake(t, l, "SBXEEEEEEEEEEEE")
	r.Errs = map[string]error{"SetComputerName": errors.New("power loss")}
	if _, _, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly); err == nil {
		t.Fatal("apply succeeded with a failing resetter")
	}
	f, err := LoadFile(l.IdentityFile)
	if err != nil || f.MachineID != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Fatalf("identity.json after the interrupted apply = %+v, %v; want the old one", f, err)
	}
	r.Errs = nil
	changed, _, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly)
	if err != nil || !changed {
		t.Fatalf("changed = %v, err = %v", changed, err)
	}
	if slices.Contains(methods(r.Calls), "NewUserPassword") {
		t.Errorf("an interrupted fork changed the password: %v", r.Calls)
	}
}

func TestApplyInterruptedRepeats(t *testing.T) {
	l := winLayout(t)
	mustWrite(t, l.StateDB, "db")
	r := newWinFake(t, l, "WIN-TEMPLATE")
	r.Errs = map[string]error{"RegenerateHostKeys": errors.New("power loss")}
	if _, _, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeSpecialize); err == nil {
		t.Fatal("apply succeeded with a failing resetter")
	}
	mustNotExist(t, l.IdentityFile)

	r.Calls, r.Errs = nil, nil
	changed, _, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("the repeated apply reported no change")
	}
	want := []string{"WipeSecrets", "SetMachineGUID", "RegenerateHostKeys", "SetComputerName", "NewUserPassword", "ActiveComputerName"}
	if got := methods(r.Calls); !slices.Equal(got, want) {
		t.Errorf("repeated calls = %v, want %v", got, want)
	}
	if _, err := LoadFile(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
}

func TestApplyPasswordFailureKeepsIdentityFile(t *testing.T) {
	l := winLayout(t)
	r := newWinFake(t, l, "WIN-TEMPLATE")
	r.Errs = map[string]error{"NewUserPassword": errors.New("policy")}
	if _, _, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeSpecialize); err == nil {
		t.Fatal("apply succeeded without a new password")
	}
	mustNotExist(t, l.IdentityFile)
}

func TestApplyInvalidMachineID(t *testing.T) {
	l := winLayout(t)
	r := newWinFake(t, l, "")
	if _, _, err := ApplyWindows(context.Background(), l, testIdentity("nope"), r, ModeEarly); err == nil {
		t.Fatal("invalid machine id accepted")
	}
	if len(r.Calls) != 0 {
		t.Errorf("calls = %v", r.Calls)
	}
}

func TestNewPassword(t *testing.T) {
	seen := map[string]bool{}
	for range 50 {
		pw, err := newPassword(DefaultUser)
		if err != nil {
			t.Fatal(err)
		}
		if len(pw) != passwordLen {
			t.Fatalf("len = %d", len(pw))
		}
		var upper, lower, digit, other bool
		for _, c := range string(pw) {
			switch {
			case unicode.IsUpper(c):
				upper = true
			case unicode.IsLower(c):
				lower = true
			case unicode.IsDigit(c):
				digit = true
			case c > ' ' && c < 0x7f:
				other = true
			default:
				t.Fatalf("unexpected character %q", c)
			}
		}
		if !upper || !lower || !digit || !other {
			t.Errorf("%d-char password misses a character class", len(pw))
		}
		if containsFold(pw, DefaultUser) {
			t.Errorf("password contains the account name")
		}
		if seen[string(pw)] {
			t.Error("password repeated")
		}
		seen[string(pw)] = true
	}
}

func TestContainsFold(t *testing.T) {
	for pw, want := range map[string]bool{
		"abUsErcd": true,
		"user":     true,
		"xxuse":    false,
		"us-er":    false,
		"":         false,
	} {
		if got := containsFold([]byte(pw), "user"); got != want {
			t.Errorf("containsFold(%q) = %v, want %v", pw, got, want)
		}
	}
}

func TestUTF16LE(t *testing.T) {
	got := utf16LE([]byte("aé\U0001F600"))
	want := []byte{'a', 0, 0xe9, 0, 0x3d, 0xd8, 0x00, 0xde}
	if !slices.Equal(got, want) {
		t.Errorf("utf16LE = %v, want %v", got, want)
	}
}
