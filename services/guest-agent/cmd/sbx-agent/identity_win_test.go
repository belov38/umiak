package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
)

// winTestDeps returns deps wired like Windows: a FakeWinResetter whose
// active computer name is active, and the Windows-only layout fields set.
func winTestDeps(t *testing.T, active string) (deps, *ident.FakeWinResetter) {
	t.Helper()
	serial := wire.SMBIOSSerial(cliMachineID, bytes.Repeat([]byte{7}, wire.SecretLen))
	d, _ := testDeps(t, ident.Static{Raw: ident.Raw{Serial: serial, UUID: cliMachineID, BootID: "boot-1"}})
	d.layout.EarlyFile = filepath.Join(d.layout.RunDir, "early.json")
	d.layout.SbxEnvFile = ""
	r := &ident.FakeWinResetter{Active: active}
	d.winResetter = r
	return d, r
}

func callNames(calls []string) []string {
	out := make([]string, 0, len(calls))
	for _, c := range calls {
		name, _, _ := strings.Cut(c, " ")
		out = append(out, name)
	}
	return out
}

func TestIdentityApplySpecializeCLI(t *testing.T) {
	d, r := winTestDeps(t, "WIN-TEMPLATE")
	var errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"identity", "apply", "--specialize"}, nil, &errOut); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errOut.String())
	}
	names := callNames(r.Calls)
	if !slices.Contains(names, "NewUserPassword") || !slices.Contains(names, "SetComputerName") {
		t.Errorf("calls = %v", r.Calls)
	}
	if slices.Contains(names, "Reboot") || slices.Contains(names, "ActiveComputerName") {
		t.Errorf("specialize asked for a reboot: %v", r.Calls)
	}
	if _, err := ident.LoadFile(d.layout.IdentityFile); err != nil {
		t.Error(err)
	}
}

func TestIdentityApplyWindowsReboots(t *testing.T) {
	d, r := winTestDeps(t, "WIN-TEMPLATE")
	var errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"identity", "apply"}, nil, &errOut); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errOut.String())
	}
	if names := callNames(r.Calls); names[len(names)-1] != "Reboot" {
		t.Errorf("calls = %v, want a final Reboot", r.Calls)
	}
}

func TestIdentityApplyFlags(t *testing.T) {
	d, _ := testDeps(t, errSource{})
	var errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"identity", "apply", "--specialize"}, nil, &errOut); code != 2 {
		t.Errorf("--specialize outside Windows: exit = %d", code)
	}
	if code := runWith(context.Background(), d, []string{"identity", "apply", "--bogus"}, nil, &errOut); code != 2 {
		t.Errorf("unknown flag: exit = %d", code)
	}
}

func TestEarlyCLI(t *testing.T) {
	d, r := winTestDeps(t, ident.WindowsComputerName(cliMachineID))
	var errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"early"}, nil, &errOut); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errOut.String())
	}
	m, err := ident.LoadEarly(d.layout.EarlyFile)
	if err != nil || m.BootID != "boot-1" {
		t.Errorf("early.json = %+v, %v", m, err)
	}
	if slices.Contains(callNames(r.Calls), "Reboot") {
		t.Errorf("calls = %v", r.Calls)
	}

	if code := runWith(context.Background(), d, []string{"early", "x"}, nil, &errOut); code != 2 {
		t.Errorf("extra arg: exit = %d", code)
	}
}

func TestEarlyCLIOutsideWindows(t *testing.T) {
	d, _ := testDeps(t, errSource{})
	var errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"early"}, nil, &errOut); code != 2 {
		t.Errorf("exit = %d, want 2", code)
	}
}

func TestSealCLIWindows(t *testing.T) {
	d, r := winTestDeps(t, "")
	if err := os.MkdirAll(d.layout.StateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(d.layout.IdentityFile, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"seal"}, &out, &errOut); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errOut.String())
	}
	if !slices.Equal(callNames(r.Calls), []string{"WipeSecrets"}) {
		t.Errorf("calls = %v, want the overwriting wipe", r.Calls)
	}
	if _, err := os.Stat(d.layout.StateDir); !os.IsNotExist(err) {
		t.Errorf("state dir still there: %v", err)
	}
}
