package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/quiesce"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

const overrideURL = "wss://override.test/v1/connect"

func TestDoctorJSONFields(t *testing.T) {
	h := newHarness(t)
	for _, v := range []string{"1.2.2", "1.2.3"} {
		if err := os.MkdirAll(update.VersionDir(h.l, v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(h.l.CurrentLink), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("versions", "1.2.3"), h.l.CurrentLink); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("versions", "1.2.2"), h.l.PreviousLink); err != nil {
		t.Fatal(err)
	}
	raw := rawFor(machineA)
	raw.Family = "sbxt1:" + overrideURL
	h.src.set(raw)
	h.seedIdentity(machineA)
	h.start()
	h.waitReady()
	eventually(t, "status.json with every phase", func() bool {
		s, ok := h.tryStatus()
		return ok && phaseState(s, "docker") == "disabled"
	})
	lease := quiesce.Lease{ID: "lease-1", Deadline: time.Now().Add(time.Minute)}
	if err := fsutil.WriteJSONAtomic(h.l.QuiesceFile, lease, 0o644); err != nil {
		t.Fatal(err)
	}

	rep := Doctor(context.Background(), h.l, h.cfg, DoctorOptions{
		Source:   h.src,
		IsActive: func(_ context.Context, unit string) string { return "active:" + unit },
		Statfs:   func(string) (uint64, uint64, error) { return 100, 40, nil },
	})
	h.stop()

	b, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, testBS) || bytes.Contains(b, []byte(base64.RawURLEncoding.EncodeToString(testBS))) {
		t.Fatal("doctor output contains the boot secret")
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	get := func(path string) any {
		var cur any = m
		for _, k := range strings.Split(path, ".") {
			mm, ok := cur.(map[string]any)
			if !ok {
				return nil
			}
			cur = mm[k]
		}
		return cur
	}
	want := map[string]any{
		"versions.current":      "1.2.3",
		"versions.previous":     "1.2.2",
		"units.sbx-identity":    "active:sbx-identity.service",
		"units.sbx-agent":       "active:sbx-agent.service",
		"identity.machine_id":   machineA,
		"tunnel_url.url":        overrideURL,
		"tunnel_url.source":     "smbios",
		"quiesce.lease_id":      "lease-1",
		"disk.path":             h.l.StateDir,
		"disk.free_bytes":       float64(40),
		"disk.total_bytes":      float64(100),
		"status.version":        "1.2.3",
		"status.identity.state": "ready",
	}
	for path, w := range want {
		if got := get(path); got != w {
			t.Errorf("%s = %v, want %v\n%s", path, got, w, b)
		}
	}
	phases, _ := get("readiness.phases").([]any)
	if len(phases) == 0 {
		t.Fatalf("readiness.phases is empty: %s", b)
	}
	var agentPhase map[string]any
	for _, p := range phases {
		if pm, _ := p.(map[string]any); pm["name"] == "agent" {
			agentPhase = pm
		}
	}
	if agentPhase["state"] != "ready" || agentPhase["ready_at"] == nil {
		t.Errorf("agent phase = %v, want ready with ready_at", agentPhase)
	}
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		if mono, _ := agentPhase["ready_at_monotonic_us"].(float64); mono <= 0 {
			t.Errorf("agent phase has no monotonic ready mark: %v", agentPhase)
		}
	}

	var text bytes.Buffer
	rep.WriteText(&text)
	for _, s := range []string{"1.2.3", "1.2.2", machineA, overrideURL, "smbios", "sbx-agent", "lease-1"} {
		if !strings.Contains(text.String(), s) {
			t.Errorf("human output lacks %q:\n%s", s, text.String())
		}
	}
}

func TestDoctorWithoutAgent(t *testing.T) {
	h := newHarness(t)
	h.src.set(ident.Raw{Serial: "broken"})
	rep := Doctor(context.Background(), h.l, h.cfg, DoctorOptions{
		Source:   h.src,
		IsActive: func(context.Context, string) string { return "inactive" },
		Statfs:   func(string) (uint64, uint64, error) { return 100, 40, nil },
	})
	if rep.TunnelURL.URL != h.cfg.TunnelURL || rep.TunnelURL.Source != "config" {
		t.Errorf("tunnel url = %+v, want the config value", rep.TunnelURL)
	}
	if rep.Status != nil || rep.StatusError == "" {
		t.Errorf("status = %s, error %q; want none with an error", rep.Status, rep.StatusError)
	}
	if rep.Identity != nil || rep.IdentityError == "" {
		t.Errorf("identity = %+v, error %q; want none with an error", rep.Identity, rep.IdentityError)
	}
	var text bytes.Buffer
	rep.WriteText(&text)
	if !strings.Contains(text.String(), "inactive") {
		t.Errorf("human output:\n%s", text.String())
	}
}
