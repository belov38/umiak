package fsutil

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
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

func TestReplaceFileFallsBackOnBusyTarget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hostname")
	if err := os.WriteFile(path, []byte("old-name-that-is-long\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A bind-mounted file (Docker's /etc/hostname) cannot be renamed over.
	orig := rename
	rename = func(string, string) error { return &os.LinkError{Op: "rename", Err: syscall.EBUSY} }
	t.Cleanup(func() { rename = orig })

	if err := WriteFileAtomic(path, []byte("x"), 0o644); !errors.Is(err, syscall.EBUSY) {
		t.Fatalf("WriteFileAtomic = %v, want EBUSY", err)
	}
	if err := ReplaceFile(path, []byte("new\n"), 0o644); err != nil {
		t.Fatalf("ReplaceFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new\n" {
		t.Errorf("content = %q, want %q", got, "new\n")
	}
	// Growing content is written whole as well.
	long := strings.Repeat("grown-content-", 100) + "\n"
	if err := ReplaceFile(path, []byte(long), 0o644); err != nil {
		t.Fatalf("ReplaceFile (grow): %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != long {
		t.Errorf("content after growing = %d bytes, want %d", len(got), len(long))
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Errorf("dir has %d entries, want no temporary file left", len(entries))
	}
}

func TestReplaceFileOtherErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f")
	if err := ReplaceFile(path, []byte("a"), 0o600); err != nil {
		t.Fatalf("ReplaceFile of a new file: %v", err)
	}
	orig := rename
	rename = func(string, string) error { return &os.LinkError{Op: "rename", Err: syscall.EACCES} }
	t.Cleanup(func() { rename = orig })
	if err := ReplaceFile(path, []byte("b"), 0o600); !errors.Is(err, syscall.EACCES) {
		t.Errorf("ReplaceFile = %v, want the rename error", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "a" {
		t.Errorf("content = %q, want unchanged", got)
	}
}
