package packaging

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/update"
)

const specPath = "../../../docs/specs/s3-guest-agent.md"

// specBlock returns the ini code block of the spec that starts with first.
func specBlock(t *testing.T, first string) string {
	t.Helper()
	b, err := os.ReadFile(specPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, block := range strings.Split(string(b), "```ini\n")[1:] {
		body, _, _ := strings.Cut(block, "```")
		if strings.HasPrefix(body, first) {
			return strings.TrimPrefix(body, first)
		}
	}
	t.Fatalf("spec has no ini block starting with %q", first)
	return ""
}

func unit(t *testing.T, name string) string {
	t.Helper()
	b, err := fs.ReadFile(Units, name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestUnitsMatchSpec(t *testing.T) {
	agent := unit(t, "umiak-agent.service")
	for _, d := range []string{
		"Type=notify",
		"ExecStart=/usr/local/lib/umiak-agent/current/umiak-agent run",
		"OOMScoreAdjust=-900",
		"MemoryMin=64M",
		"CPUWeight=500",
		"IOWeight=500",
		"Restart=always",
		// systemd >= 254 runs OnFailure= on every failed start unless the
		// restart is direct; the rollback must wait for StartLimitBurst.
		"RestartMode=direct",
		"RestartSec=1",
		// Above the identity fallbacks (up to 60 s) before READY=1. A
		// version that hangs while starting is killed and restarted; the
		// update confirmation deadline (armed early in startup) rolls it back.
		"TimeoutStartSec=90",
		"TimeoutStopSec=15",
		"StartLimitIntervalSec=120",
		"StartLimitBurst=5",
		"OnFailure=umiak-agent-rollback.service",
		"WantedBy=multi-user.target",
	} {
		if !strings.Contains(agent, "\n"+d+"\n") {
			t.Errorf("umiak-agent.service misses %q", d)
		}
	}
	if want := specBlock(t, "# umiak-agent.service\n"); agent != want {
		t.Errorf("umiak-agent.service differs from spec 17.2:\n%s\nwant:\n%s", agent, want)
	}
	const identityHead = "[Unit]\nDescription=umiak machine identity\n"
	if got, want := unit(t, "umiak-identity.service"), identityHead+specBlock(t, identityHead); got != want {
		t.Errorf("umiak-identity.service differs from spec 7.2:\n%s\nwant:\n%s", got, want)
	}

	rollback := unit(t, "umiak-agent-rollback.service")
	for _, d := range []string{
		"Type=oneshot",
		`ExecStart=/bin/sh -c 'if [ -x /usr/local/lib/umiak-agent/previous/umiak-agent ]; then exec /usr/local/lib/umiak-agent/previous/umiak-agent rollback; else exec /usr/local/lib/umiak-agent/current/umiak-agent rollback; fi'`,
	} {
		if !strings.Contains(rollback, "\n"+d+"\n") {
			t.Errorf("umiak-agent-rollback.service misses %q", d)
		}
	}
	if slice := unit(t, "umiak-cmd.slice"); slice != "[Unit]\nDescription=umiak sandbox commands\n" {
		t.Errorf("umiak-cmd.slice = %q", slice)
	}

	names, err := fs.Glob(Units, "*")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"umiak-agent-rollback.service", "umiak-agent.service", "umiak-cmd.slice", "umiak-identity.service"}; !reflect.DeepEqual(names, want) {
		t.Errorf("units = %v, want %v", names, want)
	}
}

func TestAgentTOMLIsDefaults(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.toml")
	if err := os.WriteFile(p, AgentTOML, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := config.Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if want := config.Defaults(); !reflect.DeepEqual(got, want) {
		t.Errorf("agent.toml = %+v, want defaults %+v", got, want)
	}
}

func TestUpdateKeysParse(t *testing.T) {
	keys, err := update.ParseKeys(UpdateKeys)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) == 0 {
		t.Error("no pinned update keys")
	}
}
