package packaging

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
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
	agent := unit(t, "sbx-agent.service")
	for _, d := range []string{
		"Type=notify",
		"ExecStart=/usr/local/lib/sbx-agent/current/sbx-agent run",
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
		"OnFailure=sbx-agent-rollback.service",
		"WantedBy=multi-user.target",
	} {
		if !strings.Contains(agent, "\n"+d+"\n") {
			t.Errorf("sbx-agent.service misses %q", d)
		}
	}
	if want := specBlock(t, "# sbx-agent.service\n"); agent != want {
		t.Errorf("sbx-agent.service differs from spec 17.2:\n%s\nwant:\n%s", agent, want)
	}
	const identityHead = "[Unit]\nDescription=sbx machine identity\n"
	if got, want := unit(t, "sbx-identity.service"), identityHead+specBlock(t, identityHead); got != want {
		t.Errorf("sbx-identity.service differs from spec 7.2:\n%s\nwant:\n%s", got, want)
	}

	rollback := unit(t, "sbx-agent-rollback.service")
	for _, d := range []string{
		"Type=oneshot",
		`ExecStart=/bin/sh -c 'if [ -x /usr/local/lib/sbx-agent/previous/sbx-agent ]; then exec /usr/local/lib/sbx-agent/previous/sbx-agent rollback; else exec /usr/local/lib/sbx-agent/current/sbx-agent rollback; fi'`,
	} {
		if !strings.Contains(rollback, "\n"+d+"\n") {
			t.Errorf("sbx-agent-rollback.service misses %q", d)
		}
	}
	if slice := unit(t, "sbx-cmd.slice"); slice != "[Unit]\nDescription=sbx sandbox commands\n" {
		t.Errorf("sbx-cmd.slice = %q", slice)
	}

	names, err := fs.Glob(Units, "*")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"sbx-agent-rollback.service", "sbx-agent.service", "sbx-cmd.slice", "sbx-identity.service"}; !reflect.DeepEqual(names, want) {
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
