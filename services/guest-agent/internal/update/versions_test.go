package update

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
)

func TestGCVersions(t *testing.T) {
	_, priv := testKey(t)
	l := paths.ForRoot(t.TempDir())
	for _, v := range []string{"v1", "v2", "v3", "v4", "v5"} {
		installed(t, l, v, priv)
	}
	installed(t, l, "v6", priv)
	installed(t, l, "v7", priv)
	setLinks(t, l, "v5", "v4")
	ageVersions(t, l)
	// v1 is the source of a pending update, v7 was placed just now.
	if err := writePending(l, Pending{From: "v1", To: "v6", Deadline: time.Now()}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := os.Chtimes(filepath.Join(l.VersionsDir, "v7"), now, now); err != nil {
		t.Fatal(err)
	}
	if err := GCVersions(l, []string{"v2"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(l.VersionsDir)
	if err != nil {
		t.Fatal(err)
	}
	var left []string
	for _, e := range entries {
		left = append(left, e.Name())
	}
	if !slices.Equal(left, []string{"v1", "v2", "v4", "v5", "v6", "v7"}) {
		t.Errorf("versions left = %v", left)
	}
}

func TestShimVersions(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	write := func(id, version string, exited bool) {
		dir := l.CommandDir(id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := fsutil.WriteJSONAtomic(filepath.Join(dir, shim.ShimJSON), shim.ShimFile{State: shim.StateRunning, AgentVersion: version, ShimProto: 1}, 0o644); err != nil {
			t.Fatal(err)
		}
		if exited {
			if err := os.WriteFile(filepath.Join(dir, shim.ExitJSON), []byte("{}"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	write("a", "v1", false)
	write("b", "v2", true)
	write("c", "v1", false)
	write("d", "v3", false)
	versions, protos := ShimVersions(l, nil)
	if !slices.Equal(versions, []string{"v1", "v3"}) {
		t.Errorf("versions = %v", versions)
	}
	if !slices.Equal(protos, []int{1}) {
		t.Errorf("protos = %v", protos)
	}
}

func TestPlaceVersionRefreshesMtime(t *testing.T) {
	_, priv := testKey(t)
	l := paths.ForRoot(t.TempDir())
	installed(t, l, "v1", priv)
	installed(t, l, "v2", priv)
	setLinks(t, l, "v2", "")
	ageVersions(t, l)
	// Reinstalling the identical v1 (kept as is) protects it from GC again.
	installed(t, l, "v1", priv)
	if err := GCVersions(l, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(l.VersionsDir, "v1")); err != nil {
		t.Errorf("reinstalled version collected: %v", err)
	}
}
