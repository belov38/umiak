package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"runtime"
	"strings"
	"syscall"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/quiesce"
)

// cliFreezer is a freezer with one mount for the CLI tests.
type cliFreezer struct {
	frozen   bool
	mountErr error
}

func (f *cliFreezer) Mounts() ([]quiesce.Mount, error) {
	if f.mountErr != nil {
		return nil, f.mountErr
	}
	return []quiesce.Mount{{Path: "/", Source: "/dev/vda1", FSType: "ext4"}}, nil
}

func (f *cliFreezer) Freeze(string) error {
	f.frozen = true
	return nil
}

func (f *cliFreezer) Thaw(p string) error {
	if !f.frozen {
		return &os.PathError{Op: "FITHAW", Path: p, Err: syscall.EINVAL}
	}
	f.frozen = false
	return nil
}

func TestThawForce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Linux thaw (FITHAW); Windows thaws through the agent: TestThawForceAdminSocketAgentDown, TestThawForceThroughAgent")
	}
	fz := &cliFreezer{frozen: true}
	d := deps{layout: paths.ForRoot(t.TempDir()), freezer: fz}
	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"thaw", "--force"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if fz.frozen || !strings.Contains(out.String(), "thawed") {
		t.Errorf("frozen %v, stdout %q", fz.frozen, out.String())
	}
	fz.mountErr = errors.New("no mountinfo")
	out.Reset()
	errOut.Reset()
	if code := runWith(context.Background(), d, []string{"thaw", "--force"}, &out, &errOut); code != 1 {
		t.Errorf("exit %d with a failing freezer", code)
	}
	if !strings.Contains(errOut.String(), "no mountinfo") {
		t.Errorf("stderr %q", errOut.String())
	}
}

func TestQuiesceWatchdogNoLease(t *testing.T) {
	d := deps{layout: paths.ForRoot(t.TempDir()), freezer: &cliFreezer{}}
	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"quiesce-watchdog", "--lease", "l-1"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "lease already ended") {
		t.Errorf("stderr %q", errOut.String())
	}
}
