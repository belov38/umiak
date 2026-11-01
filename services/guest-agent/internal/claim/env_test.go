package claim

import (
	"context"
	"errors"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/process"
	"github.com/belov38/umiak/services/guest-agent/internal/readiness"
)

func testUser() *process.User {
	return &process.User{Name: "user", UID: 1000, GID: 1000, Home: "/home/user", Shell: "/bin/bash"}
}

func TestFormatEnvFile(t *testing.T) {
	long := strings.Repeat("x", maxEnvFileLine-len(`L=""`+"\n"))
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"empty", nil, ""},
		{"sorted", map[string]string{"B": "2", "A": "1", "_C": "3"}, "A=\"1\"\nB=\"2\"\n_C=\"3\"\n"},
		{"quote raw", map[string]string{"Q": `say "hi"`}, `Q="say "hi""` + "\n"},
		{"backslash raw", map[string]string{"P": `C:\dir\`}, `P="C:\dir\"` + "\n"},
		{"single quote raw", map[string]string{"S": `it's`}, `S="it's"` + "\n"},
		{"spaces and empty", map[string]string{"S": "a b", "E": ""}, "E=\"\"\nS=\"a b\"\n"},
		{"hash skipped", map[string]string{"H": "a#b", "OK": "x"}, "OK=\"x\"\n"},
		{"newline skipped", map[string]string{"N": "a\nb", "OK": "x"}, "OK=\"x\"\n"},
		{"cr skipped", map[string]string{"R": "a\rb"}, ""},
		{"nul skipped", map[string]string{"Z": "a\x00b"}, ""},
		{"bad keys skipped", map[string]string{"1A": "x", "A-B": "x", "": "x", "A B": "x", "GOOD_1": "y"}, "GOOD_1=\"y\"\n"},
		{"longest line kept", map[string]string{"L": long}, `L="` + long + "\"\n"},
		{"too long skipped", map[string]string{"L": long + "x"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := string(FormatEnvFile(tt.env)); got != tt.want {
				t.Errorf("FormatEnvFile = %q, want %q", got, tt.want)
			}
		})
	}
}

// pamEnvParse reads a file the way pam_env (readenv=1) does for the lines
// FormatEnvFile writes: the value ends at the first '#', the opening quote
// and a final quote are removed, nothing is unescaped.
func pamEnvParse(data string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(data, "\n"), "\n") {
		if line == "" {
			continue
		}
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		k, v, _ := strings.Cut(line, "=")
		if strings.HasPrefix(v, `"`) || strings.HasPrefix(v, `'`) {
			q := v[0]
			v = v[1:]
			if strings.HasSuffix(v, string(q)) {
				v = v[:len(v)-1]
			}
		}
		out[k] = v
	}
	return out
}

func TestFormatEnvFileRoundTrip(t *testing.T) {
	env := map[string]string{
		"QUOTES":    `a "quoted" b`,
		"END_QUOTE": `ends with "`,
		"BACKSLASH": `C:\path\to`,
		"TRAILING":  `trailing\`,
		"SINGLE":    `it's 'x'`,
		"DOLLAR":    `$HOME and ${X}`,
		"EMPTY":     "",
	}
	got := pamEnvParse(string(FormatEnvFile(env)))
	for k, v := range env {
		if got[k] != v {
			t.Errorf("%s round-trips to %q, want %q", k, got[k], v)
		}
	}
}

func TestSecretsDigest(t *testing.T) {
	files := []*agentv1.SecretFile{
		{Name: "a", Content: []byte("1"), Mode: 0o440},
		{Name: "b", Content: []byte("2"), Mode: 0o400, LinkPath: "/x"},
	}
	d := SecretsDigest(map[string]string{"K": "v", "L": "w"}, files)
	if len(d) != 64 {
		t.Fatalf("digest %q is not hex sha256", d)
	}
	if got := SecretsDigest(map[string]string{"L": "w", "K": "v"}, []*agentv1.SecretFile{files[1], files[0]}); got != d {
		t.Error("digest depends on order")
	}
	if SecretsDigest(nil, nil) != "" {
		t.Error("empty set has a non-empty digest")
	}
	variants := []struct {
		env   map[string]string
		files []*agentv1.SecretFile
	}{
		{map[string]string{"K": "v", "L": "x"}, files},
		{map[string]string{"KL": "vw"}, files},
		{map[string]string{"K": "v", "L": "w"}, files[:1]},
		{map[string]string{"K": "v", "L": "w"}, []*agentv1.SecretFile{files[0], {Name: "b", Content: []byte("2"), Mode: 0o440, LinkPath: "/x"}}},
		{map[string]string{"K": "v", "L": "w"}, []*agentv1.SecretFile{files[0], {Name: "b", Content: []byte("2"), Mode: 0o400}}},
		{map[string]string{"K": "v", "L": "w"}, []*agentv1.SecretFile{files[0], {Name: "b", Content: []byte("3"), Mode: 0o400, LinkPath: "/x"}}},
	}
	for i, v := range variants {
		if SecretsDigest(v.env, v.files) == d {
			t.Errorf("variant %d has the same digest", i)
		}
	}
}

func TestEnvBuilderOrder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux base env; Windows: TestEnvBuilderWindowsLayers")
	}
	h := newHarness(t)
	req := fullRequest()
	req.Env = map[string]string{"UMIAK": "claim", "A": "claim", "B": "claim", "C": "claim", "HOME": "/claim"}
	req.SecretEnv = map[string]string{"B": "secret", "C": "secret"}
	if _, err := h.m.Claim(context.Background(), req); err != nil {
		t.Fatal(err)
	}

	spec := &agentv1.CommandSpec{
		Env: map[string]string{"C": "spec", "PATH": "/spec/bin"},
		Pty: &agentv1.Pty{Term: "xterm-kitty"},
	}
	env := h.m.EnvBuilder().Build(testUser(), spec)
	got := map[string]string{}
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			t.Fatalf("bad entry %q", kv)
		}
		if _, dup := got[k]; dup {
			t.Fatalf("duplicate key %s", k)
		}
		got[k] = v
	}
	want := map[string]string{
		"HOME":                                   "/claim",
		"USER":                                   "user",
		"LOGNAME":                                "user",
		"SHELL":                                  "/bin/bash",
		"PATH":                                   "/spec/bin",
		"LANG":                                   "C.UTF-8",
		"XDG_RUNTIME_DIR":                        "/run/user/1000",
		"TERM":                                   "xterm-kitty",
		"UMIAK":                                  "claim",
		"UMIAK_SANDBOX_ID":                       "umiak_1",
		"UMIAK_PORT_DOMAIN":                      "umiak.example.com",
		"__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS": ".umiak.example.com",
		"A":                                      "claim",
		"B":                                      "secret",
		"C":                                      "spec",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if len(got) != len(want) {
		t.Errorf("env has %d entries, want %d: %v", len(got), len(want), env)
	}
	if !slices.IsSorted(env) {
		t.Errorf("env is not sorted: %v", env)
	}

	// Without a PTY there is no TERM; the base PATH applies.
	plain := h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{})
	if slices.ContainsFunc(plain, func(s string) bool { return strings.HasPrefix(s, "TERM=") }) {
		t.Error("TERM set without a PTY")
	}
	if !slices.Contains(plain, "PATH="+DefaultPath) {
		t.Errorf("PATH missing: %v", plain)
	}
	// A PTY without a term gets the default.
	pty := h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{Pty: &agentv1.Pty{}})
	if !slices.Contains(pty, "TERM="+DefaultTerm) {
		t.Errorf("default TERM missing: %v", pty)
	}
}

func TestEnvBuilderBeforeClaim(t *testing.T) {
	h := newHarness(t)
	env := h.m.EnvBuilder().Build(testUser(), &agentv1.CommandSpec{})
	if !slices.Contains(env, "UMIAK=1") {
		t.Errorf("UMIAK missing: %v", env)
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, "UMIAK_SANDBOX_ID=") || strings.HasPrefix(kv, "__VITE_") {
			t.Errorf("unclaimed env has %s", kv)
		}
	}
}

func TestWatchDocker(t *testing.T) {
	t.Run("disabled", func(t *testing.T) {
		tr := readiness.New(nil, nil, nil)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		WatchDocker(ctx, tr, false, nil, nil)
		if st, _ := tr.State(readiness.PhaseDocker); st != agentv1.PhaseState_PHASE_STATE_DISABLED {
			t.Errorf("docker = %v, want disabled", st)
		}
	})

	t.Run("becomes ready then fails", func(t *testing.T) {
		tr := readiness.New(nil, nil, nil)
		var active atomic.Bool
		var pingErr atomic.Pointer[error]
		ok := error(nil)
		pingErr.Store(&ok)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			watchDocker(ctx, tr, true,
				func(context.Context) bool { return active.Load() },
				func(context.Context) error { return *pingErr.Load() },
				time.Millisecond, 5*time.Millisecond)
		}()
		waitPhase := func(want agentv1.PhaseState, wantMsg string) {
			t.Helper()
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if st, msg := tr.State(readiness.PhaseDocker); st == want && strings.Contains(msg, wantMsg) {
					return
				}
				time.Sleep(time.Millisecond)
			}
			st, msg := tr.State(readiness.PhaseDocker)
			t.Fatalf("docker = %v %q, want %v %q", st, msg, want, wantMsg)
		}
		waitState := func(want agentv1.PhaseState) { t.Helper(); waitPhase(want, "") }
		waitPhase(pending, "docker.service is not active")
		active.Store(true)
		waitState(ready)
		down := errors.New("connection refused")
		pingErr.Store(&down)
		waitPhase(agentv1.PhaseState_PHASE_STATE_FAILED, "connection refused")
		pingErr.Store(&ok)
		waitState(ready)
		active.Store(false)
		waitPhase(agentv1.PhaseState_PHASE_STATE_FAILED, "docker.service is not active")
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("watcher did not stop")
		}
	})
}

func TestSessionEnv(t *testing.T) {
	h := newHarness(t)
	if got := h.m.EnvBuilder().SessionEnv(); !slices.Equal(got, []string{"UMIAK=1", "UMIAK_ENV_APPLIED=1"}) {
		t.Errorf("before the claim: %q", got)
	}
	req := fullRequest()
	req.Env["UMIAK_SANDBOX_ID"] = "from-claim-env"
	if _, err := h.m.Claim(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	got := h.m.EnvBuilder().SessionEnv()
	for _, want := range []string{"UMIAK=1", "UMIAK_ENV_APPLIED=1", "UMIAK_PORT_DOMAIN=umiak.example.com", "FOO=bar",
		"TOKEN=" + secretEnvValue, "UMIAK_SANDBOX_ID=from-claim-env"} {
		if !slices.Contains(got, want) {
			t.Errorf("session env %q has no %q", got, want)
		}
	}
	if !slices.IsSorted(got) {
		t.Errorf("session env not sorted: %q", got)
	}
}
