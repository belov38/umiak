package update

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
	"github.com/belov38/umiak/services/guest-agent/internal/store"
)

func TestSelfTestSchema(t *testing.T) {
	_, priv := testKey(t)
	l := paths.ForRoot(t.TempDir())
	installed(t, l, "v1", priv)
	dir := filepath.Join(l.VersionsDir, "v1")

	tests := []struct {
		name   string
		schema int
		protos []int
		ok     bool
	}{
		{"current schema", store.SchemaVersion, []int{shimproto.Version}, true},
		{"fresh database", 0, nil, true},
		{"newer schema", store.SchemaVersion + 1, nil, false},
		{"negative schema", -1, nil, false},
		{"newer shim proto", store.SchemaVersion, []int{shimproto.Version + 1}, false},
		{"zero shim proto", store.SchemaVersion, []int{0}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := SelfTest(l, dir, "v1", tt.schema, tt.protos)
			if (err == nil) != tt.ok {
				t.Errorf("SelfTest = %v, want ok=%v", err, tt.ok)
			}
		})
	}

	// The compiled version must match the directory and the manifest.
	if err := SelfTest(l, dir, "dev", 0, nil); err == nil || !strings.Contains(err.Error(), "version directory") {
		t.Errorf("dev binary: %v", err)
	}
	renamed := filepath.Join(l.VersionsDir, "v9")
	if err := os.Rename(dir, renamed); err != nil {
		t.Fatal(err)
	}
	if err := SelfTest(l, renamed, "v9", 0, nil); err == nil || !strings.Contains(err.Error(), "manifest version") {
		t.Errorf("manifest mismatch: %v", err)
	}
	if err := os.Rename(renamed, dir); err != nil {
		t.Fatal(err)
	}

	// A broken config fails.
	if err := os.MkdirAll(l.EtcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(l.ConfigFile, []byte("[user\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := SelfTest(l, dir, "v1", 0, nil); err == nil {
		t.Error("broken config passed")
	}
	if err := os.Remove(l.ConfigFile); err != nil {
		t.Fatal(err)
	}

	// Missing trust files fail.
	if err := os.Remove(filepath.Join(dir, UpdateKeysName)); err != nil {
		t.Fatal(err)
	}
	if err := SelfTest(l, dir, "v1", 0, nil); err == nil {
		t.Error("missing update keys passed")
	}
}

func TestParseProtos(t *testing.T) {
	got, err := ParseProtos("1,2, 3")
	if err != nil || len(got) != 3 || got[2] != 3 {
		t.Errorf("ParseProtos = %v, %v", got, err)
	}
	if got, err := ParseProtos(""); err != nil || len(got) != 0 {
		t.Errorf("empty = %v, %v", got, err)
	}
	if _, err := ParseProtos("1,x"); err == nil {
		t.Error("bad list parsed")
	}
}
