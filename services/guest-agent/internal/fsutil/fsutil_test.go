package fsutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f")
	if err := WriteFileAtomic(path, []byte("one"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(path, []byte("two"), 0o640); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "two" {
		t.Errorf("content = %q", got)
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o640 {
			t.Errorf("perm = %v, want 0640", fi.Mode().Perm())
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Errorf("dir has %d entries, want only the target", len(entries))
	}
}

func TestWriteFileAtomicMissingDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "no", "such", "f")
	if err := WriteFileAtomic(path, []byte("x"), 0o600); err == nil {
		t.Error("want error for missing directory")
	}
}

func TestJSONRoundTrip(t *testing.T) {
	type rec struct {
		A string `json:"a"`
		B int    `json:"b"`
	}
	path := filepath.Join(t.TempDir(), "r.json")
	in := rec{A: "x", B: 7}
	if err := WriteJSONAtomic(path, in, 0o600); err != nil {
		t.Fatal(err)
	}
	var out rec
	if err := ReadJSON(path, &out); err != nil {
		t.Fatal(err)
	}
	if out != in {
		t.Errorf("out = %+v, want %+v", out, in)
	}
}

func TestReadJSONErrors(t *testing.T) {
	dir := t.TempDir()
	var v map[string]any
	if err := ReadJSON(filepath.Join(dir, "missing"), &v); !os.IsNotExist(err) {
		t.Errorf("missing file: err = %v, want not-exist", err)
	}
	bad := filepath.Join(dir, "bad")
	if err := os.WriteFile(bad, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ReadJSON(bad, &v); err == nil {
		t.Error("want error for invalid JSON")
	}
}
