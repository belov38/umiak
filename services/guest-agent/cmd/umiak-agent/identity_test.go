package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/belov38/umiak/libs/tunnel/wire"
	"github.com/belov38/umiak/services/guest-agent/internal/ident"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

const cliMachineID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"

type errSource struct{}

func (errSource) Read(context.Context) (ident.Raw, error) {
	return ident.Raw{}, errors.New("no serial")
}

func testDeps(t *testing.T, src ident.Source) (deps, *ident.FakeResetter) {
	t.Helper()
	l := paths.ForRoot(t.TempDir())
	r := &ident.FakeResetter{}
	return deps{layout: l, source: src, resetter: r, stopAgent: func() error { return nil }}, r
}

func TestIdentityApplyCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Linux identity apply; Windows: TestIdentityApplySpecializeCLI, TestIdentityApplyWindowsReboots")
	}
	serial := wire.SMBIOSSerial(cliMachineID, bytes.Repeat([]byte{7}, wire.SecretLen))
	d, r := testDeps(t, ident.Static{Raw: ident.Raw{Serial: serial, UUID: cliMachineID}})

	var errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"identity", "apply"}, nil, &errOut); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errOut.String())
	}
	if strings.Contains(errOut.String(), wire.EncodeSecret(bytes.Repeat([]byte{7}, wire.SecretLen))) {
		t.Error("log contains the boot secret")
	}
	f, err := ident.LoadFile(d.layout.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if f.MachineID != cliMachineID || !f.ResetPending {
		t.Errorf("identity.json = %+v", f)
	}
	if len(r.Calls) == 0 {
		t.Error("resetter was not used")
	}

	// A second run is a no-op.
	r.Calls = nil
	if code := runWith(context.Background(), d, []string{"identity", "apply"}, nil, &errOut); code != 0 {
		t.Fatalf("second run exit = %d", code)
	}
	if len(r.Calls) != 0 {
		t.Errorf("second run called %v", r.Calls)
	}
}

func TestIdentityApplyUnreadableSerialExitsZero(t *testing.T) {
	for name, src := range map[string]ident.Source{
		"unreadable": errSource{},
		"malformed":  ident.Static{Raw: ident.Raw{Serial: "garbage"}},
	} {
		t.Run(name, func(t *testing.T) {
			d, r := testDeps(t, src)
			var errOut bytes.Buffer
			if code := runWith(context.Background(), d, []string{"identity", "apply"}, nil, &errOut); code != 0 {
				t.Errorf("exit = %d, want 0", code)
			}
			if !strings.Contains(errOut.String(), "level=WARN") {
				t.Errorf("stderr = %q, want a warning", errOut.String())
			}
			if len(r.Calls) != 0 {
				t.Errorf("resetter calls = %v", r.Calls)
			}
			if _, err := os.Stat(d.layout.IdentityFile); err == nil {
				t.Error("identity.json written")
			}
		})
	}
}

func TestSealCLI(t *testing.T) {
	d, _ := testDeps(t, errSource{})
	state := filepath.Join(d.layout.StateDir, "state.db")
	if err := os.MkdirAll(d.layout.StateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state, []byte("db"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"seal"}, &out, &errOut); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errOut.String())
	}
	if _, err := os.Stat(d.layout.StateDir); !os.IsNotExist(err) {
		t.Errorf("state dir still there: %v", err)
	}

	d.stopAgent = func() error { return errors.New("stuck") }
	errOut.Reset()
	if code := runWith(context.Background(), d, []string{"seal"}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "stuck") {
		t.Errorf("exit = %d, stderr = %q", code, errOut.String())
	}
}
