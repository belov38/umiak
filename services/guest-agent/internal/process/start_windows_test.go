package process

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/wincmd"
)

// pathEnv is an EnvBuilder whose PATH is one directory.
type pathEnv struct{ dir string }

func (e pathEnv) Build(*User, *agentv1.CommandSpec) []string {
	return []string{"Path=" + e.dir, "PATHEXT=.COM;.EXE;.BAT;.CMD"}
}

func winTestUser() *User {
	return &User{Name: "user", Home: `C:\Users\user`, Shell: pwshPath, Windows: &WinUser{Account: "user"}}
}

func TestShellArgvPwsh(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	m := &Manager{opts: Options{Layout: l}}

	argv, err := m.shellArgv("c1", winTestUser(), "exit 7", true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(argv[:4], []string{pwshPath, "-NoLogo", "-NonInteractive", "-EncodedCommand"}) {
		t.Fatalf("argv = %q", argv)
	}
	if _, err := os.Stat(filepath.Join(l.CommandDir("c1"), wincmd.ScriptFile)); !os.IsNotExist(err) {
		t.Fatalf("short script written to a file: %v", err)
	}

	long := "Write-Output " + strings.Repeat("x", 20000)
	argv, err = m.shellArgv("c2", winTestUser(), long, false)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(l.CommandDir("c2"), wincmd.ScriptFile)
	if argv[len(argv)-2] != "-File" || argv[len(argv)-1] != file || !slices.Contains(argv, "-NoProfile") {
		t.Fatalf("argv = %q", argv)
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != wincmd.WrapScript(long) {
		t.Fatalf("script file: %v", err)
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
	} {
		if got := resolveCwd(u, cwd); got != want {
			t.Errorf("resolveCwd(%q) = %q, want %q", cwd, got, want)
		}
	}
}

func TestCheckArgvUnsafeBatch(t *testing.T) {
	bin := t.TempDir()
	for _, f := range []string{"npm.cmd", "node.exe"} {
		if err := os.WriteFile(filepath.Join(bin, f), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	m := &Manager{opts: Options{Env: pathEnv{bin}}}
	spec := func(args ...string) *agentv1.CommandSpec {
		return &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: args}}}
	}
	for _, args := range [][]string{{"npm", "install", "a b"}, {"node", "-e", `console.log("%PATH%")`}, {"missing", "%x%"}} {
		if err := m.checkArgv(winTestUser(), spec(args...)); err != nil {
			t.Errorf("%q: %v", args, err)
		}
	}
	for _, arg := range []string{"%PATH%", "a&b\"", "x\ny", "^", `C:\d\`} {
		wantCode(t, m.checkArgv(winTestUser(), spec("npm", arg)), connect.CodeInvalidArgument, errs.UnsafeBatchArgs)
	}
	shell := &agentv1.CommandSpec{Cmd: &agentv1.CommandSpec_Shell{Shell: "npm %x%"}}
	if err := m.checkArgv(winTestUser(), shell); err != nil {
		t.Errorf("shell: %v", err)
	}
}
