package claim

import (
	"errors"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/process"
)

func TestEnvBuilderWindowsLayers(t *testing.T) {
	h := newHarness(t)
	old := userEnvBlock
	t.Cleanup(func() { userEnvBlock = old })
	userEnvBlock = func(*process.User) ([]string, error) {
		return []string{`Path=C:\Windows`, `USERPROFILE=C:\Users\user`, `TEMP=C:\t`, `=C:=C:\`}, nil
	}
	req := fullRequest()
	req.Env = map[string]string{"Temp": "claim", "A": "claim"}
	h.m.mu.Lock()
	h.m.req, h.m.secretEnv = req, map[string]string{"A": "secret"}
	h.m.mu.Unlock()

	spec := &agentv1.CommandSpec{
		Env: map[string]string{"PATH": `C:\spec`},
		Pty: &agentv1.Pty{Term: "xterm-kitty"},
	}
	u := &process.User{Name: "user", Home: `C:\Users\user`, Windows: &process.WinUser{Account: "user"}}
	got := h.m.EnvBuilder().Build(u, spec)
	want := []string{
		`=C:=C:\`,
		"A=secret",
		`Path=C:\spec`,
		"UMIAK=1",
		"UMIAK_ENV_APPLIED=1",
		"UMIAK_HOSTNAME=my-box",
		"UMIAK_PORT_DOMAIN=umiak.example.com",
		"UMIAK_SANDBOX_ID=umiak_1",
		"TEMP=claim",
		"TERM=xterm-256color",
		`USERPROFILE=C:\Users\user`,
		"__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.umiak.example.com",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("env =\n%q\nwant\n%q", got, want)
	}
}

func TestEnvBuilderWindowsFallback(t *testing.T) {
	h := newHarness(t)
	old := userEnvBlock
	t.Cleanup(func() { userEnvBlock = old })
	userEnvBlock = func(*process.User) ([]string, error) { return nil, errors.New("logon failed") }
	u := &process.User{Name: "user", Home: `C:\Users\user`, Windows: &process.WinUser{Account: "user"}}
	env := h.m.EnvBuilder().Build(u, &agentv1.CommandSpec{})
	for _, kv := range []string{`USERPROFILE=C:\Users\user`, "USERNAME=user", "UMIAK=1", "UMIAK_ENV_APPLIED=1"} {
		if !slices.Contains(env, kv) {
			t.Errorf("%s missing: %q", kv, env)
		}
	}
	if slices.ContainsFunc(env, func(s string) bool { return strings.HasPrefix(s, "TERM=") }) {
		t.Error("TERM without a PTY")
	}
}
