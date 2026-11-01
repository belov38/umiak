package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/update"
)

func TestFailRunExitsAtOnce(t *testing.T) {
	d := deps{layout: paths.ForRoot(t.TempDir()), version: "9.9.9", failRun: true}
	var out, errOut bytes.Buffer
	if code := runWith(context.Background(), d, []string{"run"}, &out, &errOut); code != 1 {
		t.Fatalf("run exit = %d, want 1; stderr %s", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "failRun") {
		t.Errorf("stderr = %q, want the failRun reason", errOut.String())
	}
	// Other commands are not affected (selftest must pass for the update).
	out.Reset()
	if code := runWith(context.Background(), d, []string{"version"}, &out, &errOut); code != 0 || strings.TrimSpace(out.String()) != "9.9.9" {
		t.Errorf("version = %d %q", code, out.String())
	}
}

func TestEmbeddedKeysWithDevKey(t *testing.T) {
	pub, _ := genKey(t)
	base := []byte(update.FormatKey(pub, "pinned") + "\n")
	if got := embeddedKeys(base, ""); !bytes.Equal(got, base) {
		t.Errorf("without a dev key = %q, want the pinned file unchanged", got)
	}
	dev, _ := genKey(t)
	got := embeddedKeys(base, base64.StdEncoding.EncodeToString(dev))
	keys, err := update.ParseKeys(got)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || !keys[0].Equal(pub) || !keys[1].Equal(dev) {
		t.Errorf("keys = %d (%q), want the pinned key and the dev key", len(keys), got)
	}
}

func TestIdentityDirFromConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.toml")
	if got := identityDir(cfgPath); got != config.DefaultIdentityDir {
		t.Errorf("without agent.toml = %q, want %q", got, config.DefaultIdentityDir)
	}
	if err := os.WriteFile(cfgPath, []byte("[identity]\nsysfs_dir = \"/run/fake-dmi\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := identityDir(cfgPath); got != "/run/fake-dmi" {
		t.Errorf("with sysfs_dir = %q, want /run/fake-dmi", got)
	}
	if err := os.WriteFile(cfgPath, []byte("[identity\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := identityDir(cfgPath); got != config.DefaultIdentityDir {
		t.Errorf("with a broken agent.toml = %q, want the default", got)
	}
}

func TestDoctorReportsTestAids(t *testing.T) {
	d, _ := testDeps(t, errSource{})
	d.isActive = func(context.Context, string) string { return "active" }
	d.statfs = func(string) (uint64, uint64, error) { return 10, 5, nil }
	doc := func() map[string]any {
		var out, errOut bytes.Buffer
		if code := runWith(context.Background(), d, []string{"doctor", "--json"}, &out, &errOut); code != 0 {
			t.Fatalf("doctor exit = %d: %s", code, errOut.String())
		}
		var m map[string]any
		if err := json.Unmarshal(out.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	m := doc()
	if m["identity_dir"] != config.DefaultIdentityDir || m["test_aids"] != nil {
		t.Errorf("production build: identity_dir %v, test_aids %v", m["identity_dir"], m["test_aids"])
	}

	if err := os.MkdirAll(filepath.Dir(d.layout.ConfigFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(d.layout.ConfigFile, []byte("[identity]\nsysfs_dir = \"/run/fake-dmi\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	d.failRun, d.devKey = true, true
	m = doc()
	aids, _ := m["test_aids"].([]any)
	if m["identity_dir"] != "/run/fake-dmi" || len(aids) != 3 {
		t.Errorf("test build: identity_dir %v, test_aids %v; want /run/fake-dmi and three aids", m["identity_dir"], aids)
	}
	var out, errOut bytes.Buffer
	runWith(context.Background(), d, []string{"doctor"}, &out, &errOut)
	if !strings.Contains(out.String(), "test aids:") || !strings.Contains(out.String(), "/run/fake-dmi") {
		t.Errorf("doctor text = %s", out.String())
	}
}
