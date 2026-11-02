package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/belov38/umiak/libs/tunnel/transport"
	"github.com/belov38/umiak/libs/tunnel/wire"

	"github.com/belov38/umiak/services/guest-agent/internal/agent"
	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/ident"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/quiesce"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

// noDialer fails every tunnel dial: the CLI tests talk to the admin socket.
type noDialer struct{}

func (noDialer) Dial(context.Context, transport.Hello) (net.Conn, transport.ConnInfo, error) {
	return nil, transport.ConnInfo{}, errors.New("test: no gateway")
}

// cliAgent is an agent.Run with fakes that serves an admin and an env socket
// in a short temp dir, and the CLI deps that talk to it.
type cliAgent struct {
	l   paths.Layout
	sup *supervisor.Fake
	d   deps
}

// startCLIAgent starts the agent and waits for READY=1.
func startCLIAgent(t *testing.T) *cliAgent {
	t.Helper()
	// macOS limits socket paths to 104 bytes: the shim sockets live under
	// the layout, so the whole tree goes to a short temp dir.
	dir, err := os.MkdirTemp("", "umiakc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	l := paths.ForRoot(dir)
	// Keep the longer Umiak layout out of macOS AF_UNIX socket paths.
	l.ShimSockDir = filepath.Join(dir, "s")
	l.AdminSocket = filepath.Join(dir, "a.sock")
	l.EnvSocket = filepath.Join(dir, "e.sock")
	l.LogDir = filepath.Join(l.RunDir, "..", "logs")
	cfg := config.Defaults()
	cfg.DockerEnabled = false
	cfg.DefaultUser = cliUser(t)
	cfg.TunnelURL = "wss://tunnel.test/v1/connect"
	sup := supervisor.NewFake(l)
	t.Cleanup(func() { _ = sup.Close() })
	ready := make(chan struct{})
	var once bool
	serial := wire.SMBIOSSerial(cliMachineID, bytes.Repeat([]byte{7}, wire.SecretLen))
	ad := agent.Deps{
		Supervisor:   sup,
		IdentSource:  ident.Static{Raw: ident.Raw{Serial: serial, UUID: cliMachineID}},
		Resetter:     &ident.FakeResetter{},
		Dialer:       noDialer{},
		BootID:       func() (string, error) { return "11111111-2222-3333-4444-555555555555", nil },
		MountSecrets: func(dir string) error { return os.MkdirAll(dir, 0o755) },
		Statfs:       func(string) (uint64, uint64, error) { return 100 << 30, 50 << 30, nil },
		Hostname:     func() (string, error) { return "umiak-test", nil },
		IdleSample:   func() (float64, uint64) { return 0, 0 },
		ShimPath:     "/usr/local/lib/umiak-agent/versions/test/umiak-agent",
		Log:          slog.New(slog.DiscardHandler),
		SdNotify: func(state string) error {
			if state == "READY=1" && !once {
				once = true
				close(ready)
			}
			return nil
		},
	}
	if runtime.GOOS == "windows" {
		cliWindowsStart(t, l, &ad)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- agent.Run(ctx, l, cfg, "1.2.3", ad) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("agent stopped with %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("agent did not stop")
		}
	})
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("agent exited before READY=1: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("no READY=1")
	}
	return &cliAgent{l: l, sup: sup, d: deps{layout: l, stdin: strings.NewReader("")}}
}

// cliUser is the default user of the CLI agent: the current user, on
// Windows SYSTEM (the tests run as SYSTEM, and the agent knows only SYSTEM
// and user there; user.Current names SYSTEM WORKGROUP\<host>$).
func cliUser(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return "SYSTEM"
	}
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	return u.Username
}

// cliWindowsStart makes ad start like the Windows service (agent.WinBoot):
// the boot step of this boot is done (early.json) and identity.json names
// this machine, so the start applies nothing and reboots nothing.
func cliWindowsStart(t *testing.T, l paths.Layout, ad *agent.Deps) {
	t.Helper()
	bootID, err := ad.BootID()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(l.RunDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSONAtomic(l.EarlyFile, ident.EarlyMarker{BootID: bootID}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := (&ident.File{MachineID: cliMachineID}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	ad.Resetter = nil
	ad.WinBoot = &agent.WinBoot{
		Resetter:        &ident.FakeWinResetter{Active: ident.WindowsComputerName(cliMachineID)},
		SetupInProgress: func() bool { return false },
		StartSSH:        func(context.Context) error { return nil },
	}
}

// run returns the fake run of command id; the test fails when it was
// never launched.
func (a *cliAgent) run(t *testing.T, id string) *supervisor.FakeRun {
	t.Helper()
	r := a.sup.Run(id)
	if r == nil {
		t.Fatalf("command %s was never launched", id)
	}
	return r
}

// cli runs the CLI with stdin and returns the exit code, stdout and stderr.
func (a *cliAgent) cli(t *testing.T, stdin string, args ...string) (int, string, string) {
	t.Helper()
	d := a.d
	d.stdin = strings.NewReader(stdin)
	var out, errOut bytes.Buffer
	code := runWith(context.Background(), d, args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestCallSubcommand(t *testing.T) {
	a := startCLIAgent(t)
	code, out, errOut := a.cli(t, "", "call", "umiak.agent.v1.System/Info")
	if code != 0 {
		t.Fatalf("call Info: exit %d: %s", code, errOut)
	}
	var info map[string]any
	if err := json.Unmarshal([]byte(out), &info); err != nil {
		t.Fatalf("call Info output is not JSON: %v\n%s", err, out)
	}
	if info["machine_id"] != cliMachineID {
		t.Errorf("machine_id = %v (proto field names expected): %s", info["machine_id"], out)
	}

	claim := `{"sandbox_id":"umiak_1","hostname":"box","secretEnv":{"TOKEN":"s3"}}`
	if code, out, errOut := a.cli(t, claim, "call", "umiak.agent.v1.System/Claim", "-"); code != 0 {
		t.Fatalf("call Claim -: exit %d: %s%s", code, out, errOut)
	}
	code, out, _ = a.cli(t, "", "call", "umiak.agent.v1.System/Info", "{}")
	if code != 0 || !strings.Contains(out, `"sandbox_id": "umiak_1"`) {
		t.Errorf("Info after the claim: exit %d\n%s", code, out)
	}

	// A refused call: non-zero exit, the Connect error JSON on stderr.
	code, out, errOut = a.cli(t, `{"sandbox_id":"other","hostname":"box"}`, "call", "umiak.agent.v1.System/Claim", "-")
	if code == 0 || out != "" {
		t.Errorf("second claim: exit %d, stdout %q", code, out)
	}
	var cerr struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(errOut), &cerr); err != nil || cerr.Code == "" {
		t.Errorf("stderr is not a Connect error: %v\n%s", err, errOut)
	}

	for _, args := range [][]string{
		{"call"},
		{"call", "umiak.agent.v1.System/Nope"},
		{"call", "umiak.agent.v1.Process/Run", "{}"},
		{"call", "umiak.agent.v1.System/Info", "{not json"},
	} {
		if code, _, _ := a.cli(t, "", args...); code != 2 {
			t.Errorf("%q: exit %d, want 2", args, code)
		}
	}
}

func TestCallWithoutAgent(t *testing.T) {
	d, _ := testDeps(t, errSource{})
	d.layout.AdminSocket = shortSocketPath(t)
	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"call", "umiak.agent.v1.System/Info"}, &out, &errOut); code != 1 {
		t.Errorf("exit %d, want 1: %s", code, errOut.String())
	}
	d.layout.AdminSocket = ""
	if code := runWith(context.Background(), d, []string{"call", "umiak.agent.v1.System/Info"}, &out, &errOut); code != 2 {
		t.Errorf("without an admin socket in the layout: exit %d, want 2", code)
	}
}

func TestCallUTF8BOMStdin(t *testing.T) {
	a := startCLIAgent(t)
	for _, in := range []string{"\xef\xbb\xbf{}\r\n", "\xef\xbb\xbf\xef\xbb\xbf{}\r\n"} {
		code, out, errOut := a.cli(t, in, "call", "umiak.agent.v1.System/Info", "-")
		if code != 0 || !strings.Contains(out, cliMachineID) {
			t.Fatalf("call BOM stdin %q: exit %d, stdout %q, stderr %q", in, code, out, errOut)
		}
	}
}

func TestExecUnknownUserNotStarted(t *testing.T) {
	a := startCLIAgent(t)
	code, out, errOut := a.cli(t, "", "exec", "--user", "no-such-user-umiak-test", "--", "prog")
	if code != 127 || out != "" || !strings.Contains(errOut, "no-such-user-umiak-test") {
		t.Fatalf("exec unknown user: exit %d, stdout %q, stderr %q", code, out, errOut)
	}
}

func TestExecOtherAgentValidationStill125(t *testing.T) {
	a := startCLIAgent(t)
	a.d.newID = func() string { return "bad/id" }
	code, _, errOut := a.cli(t, "", "exec", "--", "prog")
	if code != 125 || !strings.Contains(errOut, "invalid_argument") {
		t.Fatalf("exec agent validation: exit %d, stderr %q", code, errOut)
	}
}

func TestExecSubcommandExitCode(t *testing.T) {
	a := startCLIAgent(t)
	id := "cli-exec-1"
	a.d.newID = func() string { return id }
	a.sup.Script(id, func(r *supervisor.FakeRun) {
		_ = r.Write(shim.StdoutFile, []byte("hi\n"))
		_ = r.Write(shim.StderrFile, []byte("oops\n"))
		_ = r.Exit(7)
	})
	code, out, errOut := a.cli(t, "", "exec", "--cwd", "/tmp", "--", "prog", "--flag", "a b")
	if code != 7 || out != "hi\n" || errOut != "oops\n" {
		t.Errorf("exec: exit %d, stdout %q, stderr %q; want 7, hi, oops", code, out, errOut)
	}
	if argv := a.run(t, id).Spec().Argv; strings.Join(argv, "|") != "prog|--flag|a b" {
		t.Errorf("argv = %q", argv)
	}

	// A killed command exits 128+9, on Windows 1 (TerminateJobObject).
	killed := 137
	if runtime.GOOS == "windows" {
		killed = 1
	}
	id = "cli-exec-2"
	a.sup.Script(id, func(r *supervisor.FakeRun) { _ = r.Signal(syscall.SIGKILL) })
	if code, _, errOut := a.cli(t, "", "exec", "--", "sleep", "1000"); code != killed {
		t.Errorf("killed: exit %d, want %d: %s", code, killed, errOut)
	}

	id = "cli-exec-3"
	a.sup.Script(id, func(r *supervisor.FakeRun) { _ = r.Exit(0) })
	if code, _, errOut := a.cli(t, "", "exec", "--shell", "echo ok"); code != 0 {
		t.Errorf("--shell: exit %d: %s", code, errOut)
	}

	for _, args := range [][]string{{"exec"}, {"exec", "--shell", "x", "--", "y"}} {
		if code, _, _ := a.cli(t, "", args...); code != 2 {
			t.Errorf("%q: exit %d, want 2", args, code)
		}
	}
}

func TestExecAfterPrepareStop(t *testing.T) {
	a := startCLIAgent(t)
	claim := `{"sandbox_id":"umiak_1","hostname":"box","secret_env":{"TOKEN":"s3"}}`
	if code, _, errOut := a.cli(t, claim, "call", "umiak.agent.v1.System/Claim", "-"); code != 0 {
		t.Fatalf("claim: %s", errOut)
	}
	code, out, errOut := a.cli(t, "", "call", "umiak.agent.v1.System/PrepareStop")
	if code != 0 || !strings.Contains(out, "secret_files_wiped") {
		t.Fatalf("PrepareStop: exit %d\n%s%s", code, out, errOut)
	}
	// The secrets are pending now; an exec over the admin socket does not
	// wait for them.
	id := "cli-after-stop"
	a.d.newID = func() string { return id }
	a.sup.Script(id, func(r *supervisor.FakeRun) { _ = r.Exit(3) })
	start := time.Now()
	code, _, errOut = a.cli(t, "", "exec", "--", "true")
	if code != 3 {
		t.Errorf("exec after PrepareStop: exit %d: %s", code, errOut)
	}
	if !strings.Contains(errOut, "secrets are pending") {
		t.Errorf("no pending secrets note on stderr: %q", errOut)
	}
	if d := time.Since(start); d > 10*time.Second {
		t.Errorf("exec waited %v for the pending secrets", d)
	}
}

func TestSelftestPTY(t *testing.T) {
	a := startCLIAgent(t)
	id := "cli-selftest"
	a.d.newID = func() string { return id }
	a.sup.Script(id, func(r *supervisor.FakeRun) {
		for range 500 {
			if in := r.Inputs(); len(in) > 0 {
				_ = r.Write(shim.PtyFile, append([]byte("> "), in[0].Data...))
				_ = r.Exit(0)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		_ = r.Exit(1)
	})
	code, out, errOut := a.cli(t, "", "selftest", "--pty")
	if code != 0 || !strings.Contains(out, "ok") {
		t.Errorf("selftest --pty: exit %d, stdout %q, stderr %q", code, out, errOut)
	}
	if a.run(t, id).Spec().PTY == nil {
		t.Error("selftest --pty ran without a pty")
	}
}

func TestEnvFormatPwshQuoting(t *testing.T) {
	tests := []struct {
		format string
		env    []string
		want   string
	}{
		{"pwsh", []string{"A=a'b"}, "$env:A = 'a''b'\n"},
		{"pwsh", []string{"Q=\u2018x\u2019"}, "$env:Q = '\u2018\u2018x\u2019\u2019'\n"},
		{"pwsh", []string{"A-B=1", "C}D=2"}, "${env:A-B} = '1'\n${env:C`}D} = '2'\n"},
		{"pwsh", []string{"M=line1\nline2"}, "$env:M = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('bGluZTEKbGluZTI='))\n"},
		{"pwsh", []string{"T=a\tb\x1b[0m"}, "$env:T = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('YQliG1swbQ=='))\n"},
		{"pwsh", []string{"U=caf\u00e9 'x'"}, "$env:U = 'caf\u00e9 ''x'''\n"},
		{"cmd", []string{"A=50%&x"}, "set \"A=50%%&x\"\n"},
		{"cmd", []string{"N=a\nb", "OK=1"}, "set \"OK=1\"\n"},
		{"sh", []string{"A=it's", "B-C=x"}, "export A='it'\\''s'\n"},
	}
	for _, tt := range tests {
		var out, errOut bytes.Buffer
		if err := formatEnv(&out, &errOut, tt.format, tt.env); err != nil {
			t.Errorf("%s %q: %v", tt.format, tt.env, err)
			continue
		}
		if out.String() != tt.want {
			t.Errorf("%s %q:\n got %q\nwant %q", tt.format, tt.env, out.String(), tt.want)
		}
	}
	var out, errOut bytes.Buffer
	if err := formatEnv(&out, &errOut, "fish", nil); err == nil {
		t.Error("unknown format accepted")
	}
}

func TestEnvSubcommand(t *testing.T) {
	a := startCLIAgent(t)
	claim := `{"sandbox_id":"umiak_1","hostname":"box","env":{"FOO":"it's"}}`
	if code, _, errOut := a.cli(t, claim, "call", "umiak.agent.v1.System/Claim", "-"); code != 0 {
		t.Fatalf("claim: %s", errOut)
	}
	code, out, errOut := a.cli(t, "", "env", "--format", "pwsh")
	if code != 0 {
		t.Fatalf("env: exit %d: %s", code, errOut)
	}
	for _, want := range []string{"$env:FOO = 'it''s'\n", "$env:UMIAK_SANDBOX_ID = 'umiak_1'\n", "$env:UMIAK_ENV_APPLIED = '1'\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("env output has no %q:\n%s", want, out)
		}
	}
}

func TestLogsSubcommand(t *testing.T) {
	d, _ := testDeps(t, errSource{})
	d.layout.LogDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(d.layout.LogDir, agentLogName), []byte("one\ntwo\nthree identity.reset\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"logs", "-n", "2"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if out.String() != "two\nthree identity.reset\n" {
		t.Errorf("logs -n 2 = %q", out.String())
	}
	d.layout.LogDir = ""
	if code := runWith(context.Background(), d, []string{"logs"}, &out, &errOut); code != 2 {
		t.Errorf("logs without a log directory: exit %d, want 2", code)
	}
}

func TestThawForceAdminSocketAgentDown(t *testing.T) {
	d := deps{layout: paths.ForRoot(t.TempDir())}
	d.layout.AdminSocket = shortSocketPath(t)
	if err := os.MkdirAll(d.layout.RunDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSONAtomic(d.layout.QuiesceFile, quiesce.Lease{ID: "lease-1", SecretsWiped: true}, 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"thaw", "--force"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if _, err := os.Stat(d.layout.QuiesceFile); !os.IsNotExist(err) {
		t.Errorf("lease file left: %v", err)
	}
	if !strings.Contains(out.String(), "UpdateSecrets") {
		t.Errorf("stdout %q does not say the files come back with UpdateSecrets", out.String())
	}
}

func TestThawForceThroughAgent(t *testing.T) {
	a := startCLIAgent(t)
	code, out, errOut := a.cli(t, `{"lease_ms":60000,"fs":false,"docker":false}`, "call", "umiak.agent.v1.System/Quiesce", "-")
	if code != 0 {
		t.Fatalf("quiesce: exit %d: %s", code, errOut)
	}
	if _, err := os.Stat(a.l.QuiesceFile); err != nil {
		t.Fatalf("no lease file after Quiesce: %v\n%s", err, out)
	}
	code, out, errOut = a.cli(t, "", "thaw", "--force")
	if code != 0 || !strings.Contains(out, "thawed") {
		t.Fatalf("thaw --force: exit %d, stdout %q, stderr %q", code, out, errOut)
	}
	if _, err := os.Stat(a.l.QuiesceFile); !os.IsNotExist(err) {
		t.Errorf("lease file left after thaw --force: %v", err)
	}
	code, out, _ = a.cli(t, "", "call", "umiak.agent.v1.System/Info")
	if code != 0 || strings.Contains(out, `"quiesce"`) {
		t.Errorf("lease still active: %s", out)
	}
}

func TestUnreachable(t *testing.T) {
	dial := func(errno error) error {
		return fmt.Errorf("unavailable: %w", &net.OpError{Op: "dial", Net: "unix", Err: os.NewSyscallError("connect", errno)})
	}
	for _, tt := range []struct {
		err  error
		want bool
	}{
		{dial(syscall.ENOENT), true},
		{dial(syscall.ECONNREFUSED), true},
		{dial(syscall.EACCES), false},
		{dial(syscall.EPERM), false},
		{errors.New("protocol error"), false},
	} {
		if got := unreachable(tt.err); got != tt.want {
			t.Errorf("unreachable(%v) = %v, want %v", tt.err, got, tt.want)
		}
	}
}

// shortSocketPath returns a path for a socket nobody listens on, short
// enough for macOS (104 bytes).
func shortSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "umiakn")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "none.sock")
}
