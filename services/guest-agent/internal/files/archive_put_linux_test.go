package files

import (
	"archive/tar"
	"bytes"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
)

// TestArchivePutNoSymlinksInside: openat2 with RESOLVE_NO_SYMLINKS refuses a
// symlink in the parent chain even when it points inside the target
// directory (os.Root alone would follow it).
func TestArchivePutNoSymlinksInside(t *testing.T) {
	h := newHarness(t)
	dst := h.path("dst")
	h.writeFile("dst/sub/keep", []byte("k"), 0o644)
	if err := os.Symlink("sub", filepath.Join(dst, "in")); err != nil {
		t.Fatal(err)
	}
	data := makeTar(t, tarEntry{name: "in/x", typ: tar.TypeReg, body: []byte("x")})
	res := h.do(http.MethodPut, "/files/archive", q("path", dst), bytes.NewReader(data), nil)
	wantError(t, res, http.StatusBadRequest, errs.InvalidPath)
	if _, err := os.Lstat(filepath.Join(dst, "sub", "x")); !os.IsNotExist(err) {
		t.Fatalf("written through an inner symlink: %v", err)
	}
}

// TestBeneathDirSwappedParent: a parent directory replaced by a symlink after
// it was created is refused by the confined open.
func TestBeneathDirSwappedParent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	d, err := openExtractDir(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	if err := d.Mkdir("p", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "p")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "p")); err != nil {
		t.Fatal(err)
	}
	f, err := d.Create("p/x", 0o644)
	if err == nil {
		_ = f.Close()
		t.Fatal("Create through a swapped symlink succeeded")
	}
	var cerr *connect.Error
	if !errors.As(err, &cerr) || cerr.Code() != connect.CodeInvalidArgument {
		t.Fatalf("Create = %v, want invalid_path", err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("outside written: %v", entries)
	}
}
