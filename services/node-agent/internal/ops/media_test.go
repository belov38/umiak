package ops

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

type mediaDirs struct{ iso, imp string }

func mediaHarness(t *testing.T) (*harness, mediaDirs) {
	t.Helper()
	root := t.TempDir()
	d := mediaDirs{iso: filepath.Join(root, "iso"), imp: filepath.Join(root, "import")}
	for _, dir := range []string{d.iso, d.imp} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	h := newHarness(nil)
	h.srv.Cfg.IsoDir, h.srv.Cfg.ImportDir = d.iso, d.imp
	return h, d
}

func writeFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.WriteFile(path, make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func namesOf(t *testing.T, m map[string]any, key string) []string {
	t.Helper()
	list, ok := m[key].([]any)
	if !ok {
		t.Fatalf("%s is %T, want a list", key, m[key])
	}
	out := []string{}
	for _, e := range list {
		out = append(out, e.(map[string]any)["name"].(string))
	}
	return out
}

func TestMediaListShowsOnlyOurFiles(t *testing.T) {
	h, d := mediaHarness(t)
	writeFile(t, filepath.Join(d.iso, "umiak-seed-0192abcd.iso"), 10)
	writeFile(t, filepath.Join(d.iso, "ubuntu-24.04.iso"), 20)
	writeFile(t, filepath.Join(d.iso, "umiak-seed-UPPER.iso"), 20)
	writeFile(t, filepath.Join(d.imp, "umiak-ubuntu-2404.qcow2"), 30)
	writeFile(t, filepath.Join(d.imp, "umiak-win.raw"), 40)
	writeFile(t, filepath.Join(d.imp, "other.qcow2"), 50)
	writeFile(t, filepath.Join(d.imp, "umiak-note.txt"), 50)
	writeFile(t, filepath.Join(d.imp, "umiak-a..b.raw"), 50)
	if err := os.Symlink("/etc/passwd", filepath.Join(d.imp, "umiak-link.img")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(d.imp, "umiak-dir.img"), 0o750); err != nil {
		t.Fatal(err)
	}
	m := resultMap(t, h.call(t, "media.list", nil))
	if got := namesOf(t, m, "iso"); !slices.Equal(got, []string{"umiak-seed-0192abcd.iso"}) {
		t.Errorf("iso = %v", got)
	}
	if got := namesOf(t, m, "import"); !slices.Equal(got, []string{"umiak-ubuntu-2404.qcow2", "umiak-win.raw"}) {
		t.Errorf("import = %v", got)
	}
	first := m["iso"].([]any)[0].(map[string]any)
	if first["size"].(float64) != 10 {
		t.Errorf("size = %v, want 10", first["size"])
	}
}

func TestMediaListMissingDirsAreEmpty(t *testing.T) {
	h, d := mediaHarness(t)
	h.srv.Cfg.IsoDir = filepath.Join(d.iso, "nope")
	m := resultMap(t, h.call(t, "media.list", nil))
	if len(namesOf(t, m, "iso")) != 0 || len(namesOf(t, m, "import")) != 0 {
		t.Errorf("want empty lists, got %v", m)
	}
}

func TestMediaRemoveDeletesOnlyMatchingRegularFiles(t *testing.T) {
	h, d := mediaHarness(t)
	seed := filepath.Join(d.iso, "umiak-seed-0192abcd.iso")
	img := filepath.Join(d.imp, "umiak-ubuntu.qcow2")
	keep := filepath.Join(d.iso, "ubuntu.iso")
	writeFile(t, seed, 1)
	writeFile(t, img, 1)
	writeFile(t, keep, 1)
	m := resultMap(t, h.call(t, "media.remove", map[string]any{"names": []string{"umiak-seed-0192abcd.iso", "umiak-ubuntu.qcow2", "umiak-seed-gone.iso"}}))
	if exists(seed) || exists(img) || !exists(keep) {
		t.Errorf("seed exists=%v img exists=%v keep exists=%v", exists(seed), exists(img), exists(keep))
	}
	if removed := m["removed"].([]any); len(removed) != 2 {
		t.Errorf("removed = %v", removed)
	}
	if missing := m["missing"].([]any); len(missing) != 1 || missing[0] != "umiak-seed-gone.iso" {
		t.Errorf("missing = %v", missing)
	}
}

func TestMediaRemoveRefusesBeforeRemovingAnything(t *testing.T) {
	h, d := mediaHarness(t)
	good := filepath.Join(d.iso, "umiak-seed-0192abcd.iso")
	writeFile(t, good, 1)
	outside := filepath.Join(filepath.Dir(d.iso), "x.iso")
	writeFile(t, outside, 1)
	target := filepath.Join(d.iso, "ubuntu.iso")
	writeFile(t, target, 1)
	if err := os.Symlink(target, filepath.Join(d.iso, "umiak-seed-a.iso")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(d.imp, "umiak-dir.img"), 0o750); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"../x.iso", "foo.iso", "umiak-seed-a.iso", "umiak-dir.img", "sub/umiak-seed-a.iso", "umiak-seed-..iso", "umiak-seed-a.iso/", "", "/etc/passwd", "umiak-seed-UP.iso", "umiak-a..b.raw"} {
		r := h.call(t, "media.remove", map[string]any{"names": []string{"umiak-seed-0192abcd.iso", bad}})
		if r.OK || r.Error.Code != "forbidden" {
			t.Errorf("name %q: want forbidden, got %+v", bad, r)
		}
		if !exists(good) || !exists(outside) || !exists(target) {
			t.Fatalf("name %q: a file was removed", bad)
		}
	}
}
