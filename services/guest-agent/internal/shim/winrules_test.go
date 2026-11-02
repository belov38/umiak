package shim

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
	"github.com/belov38/umiak/services/guest-agent/internal/wincmd"
)

func TestWinSignalAction(t *testing.T) {
	tests := []struct {
		sig  int
		pty  bool
		want winAction
	}{
		{2, false, winSoft},
		{15, false, winSoft},
		{2, true, winSoft},
		{15, true, winSoft},
		{9, false, winTerminate},
		{9, true, winTerminate},
		{1, true, winHangup},
		{1, false, 0},
		{3, false, 0},
		{10, true, 0},
		{28, true, 0},
	}
	for _, tt := range tests {
		got, err := winSignalAction(tt.sig, tt.pty)
		if tt.want == 0 {
			if !errors.Is(err, errUnsupportedSignal) {
				t.Errorf("sig %d pty %v: %v, %v; want errUnsupportedSignal", tt.sig, tt.pty, got, err)
			}
			continue
		}
		if err != nil || got != tt.want {
			t.Errorf("sig %d pty %v = %v, %v; want %v", tt.sig, tt.pty, got, err, tt.want)
		}
	}
}

func TestWinExit(t *testing.T) {
	tests := []struct {
		name       string
		code       uint32
		terminated bool
		killReason string
		signalled  bool
		wantStatus string
		wantCode   int32
		wantReason string
	}{
		{"exit 3", 3, false, "", false, shimproto.StatusExited, 3, shimproto.ReasonNone},
		{"ntstatus as is", 0xC0000005, false, "", false, shimproto.StatusExited, -1073741819, shimproto.ReasonNone},
		{"ctrl-break exit after kill", 0xC000013A, false, shimproto.ReasonSignal, false, shimproto.StatusExited, -1073741510, shimproto.ReasonSignal},
		{"terminated by kill", 1, true, shimproto.ReasonSignal, false, shimproto.StatusKilled, 1, shimproto.ReasonSignal},
		{"terminated by timeout", 1, true, shimproto.ReasonTimeout, false, shimproto.StatusKilled, 1, shimproto.ReasonTimeout},
		{"terminated by pty idle", 1, true, shimproto.ReasonPTYIdle, false, shimproto.StatusKilled, 1, shimproto.ReasonPTYIdle},
		{"terminated by SIGKILL request", 1, true, "", true, shimproto.StatusKilled, 1, shimproto.ReasonSignal},
		// The process exited on its own before the terminate reached it.
		{"exited before terminate", 4, true, shimproto.ReasonSignal, false, shimproto.StatusExited, 4, shimproto.ReasonSignal},
		{"signal request, own exit", 0, false, "", true, shimproto.StatusExited, 0, shimproto.ReasonNone},
	}
	for _, tt := range tests {
		st, code, reason := winExit(tt.code, tt.terminated, tt.killReason, tt.signalled)
		if st != tt.wantStatus || code != tt.wantCode || reason != tt.wantReason {
			t.Errorf("%s: winExit = %s, %d, %s; want %s, %d, %s", tt.name, st, code, reason,
				tt.wantStatus, tt.wantCode, tt.wantReason)
		}
	}
}

func TestWinCommandLine(t *testing.T) {
	bin, sys := t.TempDir(), t.TempDir()
	for _, f := range []string{"npm.cmd", "node.exe"} {
		if err := os.WriteFile(filepath.Join(bin, f), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	env := []string{"Path=" + bin, "PATHEXT=.COM;.EXE;.BAT;.CMD"}

	app, line, err := winCommandLine([]string{"node", "-e", "a b"}, env, "", sys)
	if err != nil || app != filepath.Join(bin, "node.exe") || line != `node -e "a b"` {
		t.Fatalf("node: %q, %q, %v", app, line, err)
	}
	// A batch file runs through cmd.exe of the system directory.
	app, line, err = winCommandLine([]string{"npm.cmd.", "install", "x&y"}, env, "", sys)
	want := `cmd.exe /d /s /c ""` + filepath.Join(bin, "npm.cmd") + `" install "x&y""`
	if err != nil || app != filepath.Join(sys, "cmd.exe") || line != want {
		t.Fatalf("npm: %q, %q, %v; want %q", app, line, err, want)
	}
	if _, _, err := winCommandLine([]string{"npm", "%PATH%"}, env, "", sys); !errors.Is(err, wincmd.ErrUnsafeBatchArgs) {
		t.Fatalf("unsafe batch args: %v", err)
	}
	if _, _, err := winCommandLine([]string{"missing"}, env, "", sys); !errors.Is(err, wincmd.ErrNotFound) {
		t.Fatalf("missing program: %v", err)
	}
}
