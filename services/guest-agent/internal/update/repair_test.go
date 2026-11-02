package update

import (
	"os"
	"testing"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

func TestRepairCurrent(t *testing.T) {
	_, priv := testKey(t)
	tests := []struct {
		name     string
		pending  *Pending
		previous string
		want     string
	}{
		{"pending target", &Pending{From: "1.0.0", To: "1.1.0"}, "1.0.0", "1.1.0"},
		{"pending target not installed", &Pending{From: "1.0.0", To: "9.9.9"}, "", "1.0.0"},
		{"previous", nil, "1.0.0", "1.0.0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := paths.ForRoot(t.TempDir())
			installed(t, l, "1.0.0", priv)
			installed(t, l, "1.1.0", priv)
			setLinks(t, l, "", tt.previous)
			if tt.pending != nil {
				tt.pending.Deadline = time.Now().Add(time.Minute)
				if err := writePending(l, *tt.pending); err != nil {
					t.Fatal(err)
				}
			}
			got, err := RepairCurrent(l)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want || linkTarget(t, l.CurrentLink) != tt.want {
				t.Errorf("repaired to %q, current -> %q, want %q", got, linkTarget(t, l.CurrentLink), tt.want)
			}
		})
	}
}

func TestRepairCurrentLeavesExisting(t *testing.T) {
	_, priv := testKey(t)
	l := paths.ForRoot(t.TempDir())
	installed(t, l, "1.0.0", priv)
	installed(t, l, "1.1.0", priv)
	setLinks(t, l, "1.1.0", "1.0.0")
	got, err := RepairCurrent(l)
	if err != nil || got != "" {
		t.Fatalf("RepairCurrent = %q, %v; want no change", got, err)
	}
	if linkTarget(t, l.CurrentLink) != "1.1.0" {
		t.Errorf("current -> %q", linkTarget(t, l.CurrentLink))
	}
}

func TestRepairCurrentNothingToPointAt(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	if err := os.MkdirAll(l.VersionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := RepairCurrent(l); err == nil {
		t.Error("want an error without pending update or previous")
	}
}
