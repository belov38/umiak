package ops

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sha256Harness(t *testing.T) (*harness, mediaDirs, *[]string) {
	t.Helper()
	h, d := mediaHarness(t)
	h.srv.Cfg.StateDir = filepath.Join(filepath.Dir(d.iso), "state")
	hashed := &[]string{}
	h.srv.OnHash = func(name string) { *hashed = append(*hashed, name) }
	return h, d, hashed
}

func TestMediaSha256(t *testing.T) {
	h, d, hashed := sha256Harness(t)
	content := []byte("windows iso stand-in")
	name := "Win11_25H2_English_x64.iso"
	path := filepath.Join(d.iso, name)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	want := hex.EncodeToString(sum[:])

	m := resultMap(t, h.call(t, "media.sha256", map[string]any{"name": name}))
	if m["name"] != name || m["sha256"] != want || m["size"].(float64) != float64(len(content)) {
		t.Errorf("result = %v, want sha256 %s", m, want)
	}
	m = resultMap(t, h.call(t, "media.sha256", map[string]any{"name": name}))
	if m["sha256"] != want {
		t.Errorf("cached result = %v", m)
	}
	if len(*hashed) != 1 {
		t.Fatalf("hashed %d times after two calls, want 1 (second served from cache)", len(*hashed))
	}

	// A changed mtime invalidates the cache entry.
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
	resultMap(t, h.call(t, "media.sha256", map[string]any{"name": name}))
	if len(*hashed) != 2 {
		t.Errorf("hashed %d times after mtime change, want 2", len(*hashed))
	}

	// A changed size invalidates it too, and the new content gives the new digest.
	content2 := []byte("windows iso stand-in, longer")
	if err := os.WriteFile(path, content2, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
	sum2 := sha256.Sum256(content2)
	m = resultMap(t, h.call(t, "media.sha256", map[string]any{"name": name}))
	if m["sha256"] != hex.EncodeToString(sum2[:]) || len(*hashed) != 3 {
		t.Errorf("after size change: %v, hashed %d", m, len(*hashed))
	}
}

func TestMediaSha256CacheSurvivesNewServer(t *testing.T) {
	h, d, hashed := sha256Harness(t)
	writeFile(t, filepath.Join(d.iso, "a.iso"), 5)
	resultMap(t, h.call(t, "media.sha256", map[string]any{"name": "a.iso"}))
	// Every sbx-node invocation is a fresh process: the cache must live on disk.
	h2 := newHarness(nil)
	h2.srv.Cfg = h.srv.Cfg
	h2.srv.OnHash = func(string) { *hashed = append(*hashed, "again") }
	resultMap(t, h2.call(t, "media.sha256", map[string]any{"name": "a.iso"}))
	if len(*hashed) != 1 {
		t.Errorf("hashed %d times across processes, want 1", len(*hashed))
	}
}

func TestMediaSha256RejectsSymlink(t *testing.T) {
	h, d, hashed := sha256Harness(t)
	target := filepath.Join(filepath.Dir(d.iso), "secret.iso")
	writeFile(t, target, 3)
	if err := os.Symlink(target, filepath.Join(d.iso, "link.iso")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(d.iso, "dir.iso"), 0o750); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"link.iso", "dir.iso"} {
		r := h.call(t, "media.sha256", map[string]any{"name": name})
		if r.OK || r.Error.Code != "forbidden" {
			t.Errorf("%s: want forbidden, got %+v", name, r)
		}
	}
	if len(*hashed) != 0 {
		t.Errorf("hashed %v, want nothing", *hashed)
	}
}

func TestMediaSha256RejectsTraversal(t *testing.T) {
	h, d, hashed := sha256Harness(t)
	writeFile(t, filepath.Join(filepath.Dir(d.iso), "x.iso"), 3)
	writeFile(t, filepath.Join(d.iso, "ok.iso"), 3)
	writeFile(t, filepath.Join(d.iso, "note.txt"), 3)
	for _, name := range []string{"../x.iso", "sub/ok.iso", "/etc/passwd", "..", "a..b.iso", "ok.iso/", `..\x.iso`, "note.txt", "ok.iso\x00.txt", "ok"} {
		r := h.call(t, "media.sha256", map[string]any{"name": name})
		if r.OK || r.Error.Code != "forbidden" {
			t.Errorf("name %q: want forbidden, got %+v", name, r)
		}
	}
	if r := h.call(t, "media.sha256", map[string]any{"name": ""}); r.OK || r.Error.Code != "bad_request" {
		t.Errorf("empty name: want bad_request, got %+v", r)
	}
	if r := h.call(t, "media.sha256", map[string]any{}); r.OK || r.Error.Code != "bad_request" {
		t.Errorf("no name: want bad_request, got %+v", r)
	}
	if r := h.call(t, "media.sha256", map[string]any{"name": "gone.iso"}); r.OK || r.Error.Code != "not_found" {
		t.Errorf("missing file: want not_found, got %+v", r)
	}
	if len(*hashed) != 0 {
		t.Errorf("hashed %v, want nothing", *hashed)
	}
}

func TestMediaRemoveAcceptsBuildIsos(t *testing.T) {
	h, d := mediaHarness(t)
	names := []string{"sbx-build-20261031-1.iso", "sbx-offline-20261031-1.iso", "sbx-virtio-win-0.1.271.iso"}
	for _, n := range names {
		writeFile(t, filepath.Join(d.iso, n), 1)
	}
	user := filepath.Join(d.iso, "Windows11_25H2_English_x64.iso")
	writeFile(t, user, 1)

	m := resultMap(t, h.call(t, "media.list", nil))
	if got := namesOf(t, m, "iso"); len(got) != 3 {
		t.Errorf("list iso = %v, want the three sbx ISOs only", got)
	}
	m = resultMap(t, h.call(t, "media.remove", map[string]any{"names": names}))
	if removed := m["removed"].([]any); len(removed) != 3 {
		t.Errorf("removed = %v", removed)
	}
	for _, n := range names {
		if exists(filepath.Join(d.iso, n)) {
			t.Errorf("%s still exists", n)
		}
	}
	for _, bad := range []string{"Windows11_25H2_English_x64.iso", "sbx-virtio-win-latest.iso", "sbx-virtio-win-0.1.iso", "sbx-build-UP.iso", "sbx-offline-.iso"} {
		r := h.call(t, "media.remove", map[string]any{"names": []string{bad}})
		if r.OK || r.Error.Code != "forbidden" {
			t.Errorf("%s: want forbidden, got %+v", bad, r)
		}
	}
	if !exists(user) {
		t.Error("user ISO was removed")
	}
}
