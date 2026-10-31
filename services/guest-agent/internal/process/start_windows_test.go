package process

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/wincmd"
)

// pathEnv is an EnvBuilder whose PATH is one directory; the spec env is
// merged over it. It counts its builds.
type pathEnv struct {
	dir    string
	builds *atomic.Int32
}

func (e pathEnv) Build(_ *User, spec *agentv1.CommandSpec) []string {
	if e.builds != nil {
		e.builds.Add(1)
	}
	var specEnv []string
	for k, v := range spec.GetEnv() {
		specEnv = append(specEnv, k+"="+v)
	}
	return wincmd.MergeEnv([]string{"Path=" + e.dir, "PATHEXT=.COM;.EXE;.BAT;.CMD"}, specEnv)
}

func winTestUser() *User {
	return &User{Name: "user", Home: `C:\Users\user`, Shell: pwshPath, Windows: &WinUser{Account: "user"}}
}

func TestShellArgvPwsh(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	m := &Manager{opts: Options{Layout: l}}

	argv, script, err := m.shellArgv("c1", winTestUser(), "exit 7", true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(argv[:4], []string{pwshPath, "-NoLogo", "-NonInteractive", "-EncodedCommand"}) || script != "" {
		t.Fatalf("argv = %q, script %d bytes", argv, len(script))
	}

	// A long script goes to the shim in the spec; the agent writes no file.
	long := "Write-Output " + strings.Repeat("x", 20000)
	argv, script, err = m.shellArgv("c2", winTestUser(), long, false)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(l.CommandDir("c2"), wincmd.ScriptFile)
	if argv[len(argv)-2] != "-File" || argv[len(argv)-1] != file || !slices.Contains(argv, "-NoProfile") {
		t.Fatalf("argv = %q", argv)
	}
	if script != wincmd.WrapScript(long) {
		t.Fatal("script is not the wrapped script")
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("the agent wrote the script file: %v", err)
	}
}

func TestResolveCwdWindows(t *testing.T) {
	u := winTestUser()
	for cwd, want := range map[string]string{
		"":       u.Home,
		"work":   u.Home + `\work`,
		`a\..\b`: u.Home + `\b`,
		`D:\x`:   `D:\x`,
		`C:/y`:   `C:/y`,
		`\\s\sh`: `\\s\sh`,
		`\x`:     `C:\x`,
		`/x/y`:   `C:\x\y`,
		`\`:      `C:\`,
	} {
		got, err := resolveCwd(u, cwd)
		if err != nil || got != want {
			t.Errorf("resolveCwd(%q) = %q, %v; want %q", cwd, got, err, want)
		}
	}
	for _, cwd := range []string{"C:x", "D:", `d:..\y`} {
		_, err := resolveCwd(u, cwd)
		wantCode(t, err, connect.CodeInvalidArgument, errs.InvalidArgument)
	}
}

func argvSpecWin(args ...string) *agentv1.CommandSpec {
	return &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: args}}}
}

func TestPrepareSpecUnsafeBatch(t *testing.T) {
	bin := t.TempDir()
	for _, f := range []string{"npm.cmd", "node.exe"} {
		if err := os.WriteFile(filepath.Join(bin, f), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := &Manager{opts: Options{Env: pathEnv{dir: bin}}}
	for _, args := range [][]string{{"npm", "install", "a b", "x&calc"}, {"node", "-e", `console.log("%PATH%")`}, {"missing", "%x%"}} {
		if _, err := m.prepareSpec(winTestUser(), argvSpecWin(args...)); err != nil {
			t.Errorf("%q: %v", args, err)
		}
	}
	for _, arg := range []string{"%PATH%", "a&b\"", "x\ny", "^", `C:\d\`} {
		_, err := m.prepareSpec(winTestUser(), argvSpecWin("npm", arg))
		wantCode(t, err, connect.CodeInvalidArgument, errs.UnsafeBatchArgs)
	}
	// Trailing dots and spaces name the same batch file (CVE-2024-43402
	// class), also through PATHEXT from the spec env.
	for _, prog := range []string{"npm.cmd.", "npm.cmd ", "npm.cmd. ."} {
		_, err := m.prepareSpec(winTestUser(), argvSpecWin(prog, "%x%"))
		wantCode(t, err, connect.CodeInvalidArgument, errs.UnsafeBatchArgs)
	}
	spec := argvSpecWin("npm", "%x%")
	spec.Env = map[string]string{"PATHEXT": ".CMD."}
	_, err := m.prepareSpec(winTestUser(), spec)
	wantCode(t, err, connect.CodeInvalidArgument, errs.UnsafeBatchArgs)

	shell := &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Shell{Shell: "npm %x%"}}
	if _, err := m.prepareSpec(winTestUser(), shell); err != nil {
		t.Errorf("shell: %v", err)
	}
	bad := argvSpecWin("node")
	bad.Cwd = "C:x"
	_, err = m.prepareSpec(winTestUser(), bad)
	wantCode(t, err, connect.CodeInvalidArgument, errs.InvalidArgument)
}

// The env built by prepareSpec is the one in the shim spec: one build (one
// logon) per Start.
func TestPrepareSpecEnvOnce(t *testing.T) {
	var builds atomic.Int32
	cfg := config.Defaults()
	cfg.DefaultUser = "SYSTEM"
	m := &Manager{opts: Options{Env: pathEnv{dir: t.TempDir(), builds: &builds}, Config: cfg, Layout: paths.ForRoot(t.TempDir())}}
	spec := argvSpecWin("node", "x")
	u, err := LookupUser("SYSTEM")
	if err != nil {
		t.Fatal(err)
	}
	env, err := m.prepareSpec(u, spec)
	if err != nil || env == nil {
		t.Fatalf("prepareSpec = %q, %v", env, err)
	}
	ss, err := m.shimSpec("c1", spec, env)
	if err != nil {
		t.Fatal(err)
	}
	if n := builds.Load(); n != 1 || !slices.Equal(ss.Env, env) {
		t.Fatalf("%d builds, env %q", n, ss.Env)
	}
}
