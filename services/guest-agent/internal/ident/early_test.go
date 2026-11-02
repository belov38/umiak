package ident

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
)

func earlySource(bootID string) Static {
	return Static{Raw: Raw{Serial: testSerial(testMachineID), UUID: testMachineID, BootID: bootID}}
}

func TestEarlyFirstBoot(t *testing.T) {
	l := winLayout(t)
	mustWrite(t, l.QuiesceFile, "{}")
	mustWrite(t, filepath.Join(l.QuiesceThawedDir, "x"), "")
	mustWrite(t, l.StatusFile, "{}")
	mustWrite(t, filepath.Join(l.ShimSockDir, "c1.sock"), "")
	mustWrite(t, l.AdminSocket, "")
	r := newWinFake(t, l, testComputerName)

	if err := Early(context.Background(), l, earlySource("boot-1"), r); err != nil {
		t.Fatal(err)
	}
	m, err := LoadEarly(l.EarlyFile)
	if err != nil {
		t.Fatal(err)
	}
	if m.BootID != "boot-1" {
		t.Errorf("early.json bootId = %q", m.BootID)
	}
	if _, err := LoadFile(l.IdentityFile); err != nil {
		t.Errorf("identity not applied: %v", err)
	}
	// Apply wipes once, early wipes again on every boot.
	if n := countCalls(r.Calls, "WipeSecrets"); n != 2 {
		t.Errorf("WipeSecrets calls = %d, want 2 (%v)", n, r.Calls)
	}
	mustNotExist(t, l.QuiesceFile)
	mustNotExist(t, l.QuiesceThawedDir)
	mustNotExist(t, l.StatusFile)
	mustRead(t, filepath.Join(l.ShimSockDir, "c1.sock"))
	mustRead(t, l.AdminSocket)
	if slices.Contains(methods(r.Calls), "Reboot") {
		t.Error("rebooted without a name change")
	}
}

func TestEarlySameBootKeepsRunDir(t *testing.T) {
	l := winLayout(t)
	r := newWinFake(t, l, testComputerName)
	if err := Early(context.Background(), l, earlySource("boot-1"), r); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, l.QuiesceFile, "{}")
	r.Calls = nil
	if err := Early(context.Background(), l, earlySource("boot-1"), r); err != nil {
		t.Fatal(err)
	}
	mustRead(t, l.QuiesceFile)
	if got := methods(r.Calls); !slices.Equal(got, []string{"ActiveComputerName", "WipeSecrets"}) {
		t.Errorf("calls = %v", got)
	}

	if err := Early(context.Background(), l, earlySource("boot-2"), r); err != nil {
		t.Fatal(err)
	}
	mustNotExist(t, l.QuiesceFile)
}

func TestEarlyRebootsOnNameChange(t *testing.T) {
	l := winLayout(t)
	if err := (&File{MachineID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	r := newWinFake(t, l, "UMIEEEEEEEEEEEE")
	if err := Early(context.Background(), l, earlySource("boot-1"), r); err != nil {
		t.Fatal(err)
	}
	got := methods(r.Calls)
	if len(got) == 0 || got[len(got)-1] != "Reboot" {
		t.Errorf("calls = %v, want a final Reboot", got)
	}
	if slices.Contains(got, "NewUserPassword") {
		t.Error("fork changed the password")
	}
	// The service must not take the marker of a boot that is going away.
	mustNotExist(t, l.EarlyFile)
	f, err := LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if f.MachineID != testMachineID {
		t.Errorf("identity.json not saved before the reboot: %+v", f)
	}
}

func TestEarlyWithoutIdentityStillWipes(t *testing.T) {
	l := winLayout(t)
	r := newWinFake(t, l, "WIN-X")
	src := Static{Raw: Raw{Serial: "garbage", BootID: "boot-1"}}
	if err := Early(context.Background(), l, src, r); err != nil {
		t.Fatal(err)
	}
	if got := methods(r.Calls); !slices.Equal(got, []string{"WipeSecrets"}) {
		t.Errorf("calls = %v, want only WipeSecrets", got)
	}
	m, err := LoadEarly(l.EarlyFile)
	if err != nil || m.BootID != "boot-1" {
		t.Errorf("early.json = %+v, %v", m, err)
	}
}

func TestEarlyWipeFailureWritesNoMarker(t *testing.T) {
	l := winLayout(t)
	if err := (&File{MachineID: testMachineID}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	r := newWinFake(t, l, testComputerName)
	r.Errs = map[string]error{"WipeSecrets": errors.New("in use")}
	if err := Early(context.Background(), l, earlySource("boot-1"), r); err == nil {
		t.Fatal("early succeeded without wiping the secrets")
	}
	mustNotExist(t, l.EarlyFile)
}

func countCalls(calls []string, name string) int {
	n := 0
	for _, m := range methods(calls) {
		if m == name {
			n++
		}
	}
	return n
}

func TestEarlyApplyFailureStillWipes(t *testing.T) {
	l := winLayout(t)
	r := newWinFake(t, l, "WIN-TEMPLATE")
	r.Errs = map[string]error{"SetMachineGUID": errors.New("registry")}
	if err := Early(context.Background(), l, earlySource("boot-1"), r); err == nil {
		t.Fatal("early succeeded with a failing apply")
	}
	if n := countCalls(r.Calls, "WipeSecrets"); n != 2 {
		t.Errorf("WipeSecrets calls = %d, want 2 (%v)", n, r.Calls)
	}
	mustNotExist(t, l.EarlyFile)
	mustNotExist(t, l.IdentityFile)
}

func TestEarlyDoneForBoot(t *testing.T) {
	l := winLayout(t)
	if EarlyDoneForBoot(l.EarlyFile, "boot-1") {
		t.Error("done without early.json")
	}
	mustWrite(t, l.EarlyFile, `{"bootId":""}`)
	if EarlyDoneForBoot(l.EarlyFile, "") || EarlyDoneForBoot(l.EarlyFile, "boot-1") {
		t.Error("an empty bootId in early.json counts as this boot")
	}
	mustWrite(t, l.EarlyFile, `{"bootId":"boot-0"}`)
	if EarlyDoneForBoot(l.EarlyFile, "boot-1") {
		t.Error("early.json of another boot counts")
	}
	mustWrite(t, l.EarlyFile, `{"bootId":"boot-1"}`)
	if !EarlyDoneForBoot(l.EarlyFile, "boot-1") {
		t.Error("early.json of this boot does not count")
	}
}

func TestEarlySecuresAgentDirs(t *testing.T) {
	l := winLayout(t)
	r := newWinFake(t, l, testComputerName)
	if err := Early(context.Background(), l, earlySource("boot-1"), r); err != nil {
		t.Fatal(err)
	}
	for _, d := range []struct {
		dir string
		a   fsutil.DirAccess
	}{{l.RunDir, fsutil.SystemAndAdmins}, {l.StateDir, fsutil.SystemOnly}} {
		if ok, err := fsutil.IsSecure(d.dir, d.a); err != nil || !ok {
			t.Errorf("%s: IsSecure = %v, %v; want 0700, the protected DACL on Windows", d.dir, ok, err)
		}
	}
}
