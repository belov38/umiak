package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// TestDoctorWindowsParts: the units, the service check and the early.json
// check that Windows plugs into doctor.
func TestDoctorWindowsParts(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	l.EarlyFile = filepath.Join(l.RunDir, "early.json")
	raw := rawFor(machineA)
	raw.BootID = "boot-7"
	src := &switchSource{raw: raw}
	opts := DoctorOptions{
		Source:   src,
		IsActive: func(_ context.Context, unit string) string { return "running:" + unit },
		Units:    []DoctorUnit{{Key: "sbx-agent", Unit: "sbx-agent"}},
		Service: func(context.Context) *ServiceReport {
			return &ServiceReport{Name: "sbx-agent", State: "running", Problems: []string{"preshutdown timeout 0s, want 15s"}}
		},
		Statfs: func(string) (uint64, uint64, error) { return 1, 1, nil },
	}

	rep := Doctor(context.Background(), l, config.Defaults(), opts)
	if len(rep.Units) != 1 || rep.Units["sbx-agent"] != "running:sbx-agent" {
		t.Errorf("units = %v", rep.Units)
	}
	if rep.Service == nil || rep.Service.Configured {
		t.Errorf("service = %+v", rep.Service)
	}
	if rep.Early == nil || rep.Early.Current || rep.Early.CurrentBootID != "boot-7" || rep.Early.Error == "" {
		t.Errorf("early without early.json = %+v", rep.Early)
	}

	if err := os.MkdirAll(l.RunDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSONAtomic(l.EarlyFile, ident.EarlyMarker{BootID: "boot-7"}, 0o644); err != nil {
		t.Fatal(err)
	}
	rep = Doctor(context.Background(), l, config.Defaults(), opts)
	if !rep.Early.Current || rep.Early.Error != "" {
		t.Errorf("early = %+v", rep.Early)
	}
	var text bytes.Buffer
	rep.WriteText(&text)
	for _, want := range []string{"unit:       sbx-agent running:sbx-agent", "service:    sbx-agent misconfigured: preshutdown", "early:      ran for boot boot-7"} {
		if !strings.Contains(text.String(), want) {
			t.Errorf("text misses %q:\n%s", want, text.String())
		}
	}

	// Linux: no early.json path, no service check, the systemd units.
	linux := paths.ForRoot(t.TempDir())
	linux.EarlyFile = ""
	rep = Doctor(context.Background(), linux, config.Defaults(), DoctorOptions{
		Source:   src,
		IsActive: opts.IsActive,
		Statfs:   opts.Statfs,
	})
	b, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), `"early"`) || strings.Contains(string(b), `"service"`) || len(rep.Units) != 2 {
		t.Errorf("linux report = %s", b)
	}
}
