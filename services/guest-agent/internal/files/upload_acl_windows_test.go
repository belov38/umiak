package files

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

func TestUploadInheritsTargetACL(t *testing.T) {
	root := t.TempDir()
	state, dest := filepath.Join(root, "state"), filepath.Join(root, "dest")
	if err := fsutil.MkdirSecure(state, fsutil.SystemOnly); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.MkdirSecure(dest, fsutil.SystemAndAdmins); err != nil {
		t.Fatal(err)
	}
	src, target := filepath.Join(state, "upload"), filepath.Join(dest, "file.txt")
	if err := os.WriteFile(src, []byte("upload"), 0600); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t)
	rec := &store.Upload{ID: "acl", TempPath: src, CommitPath: target, CommitTarget: target}
	if err := h.svc.finishUpload(t.Context(), rec, target, 0644, owner{}, true); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sd.String(), ";;;BA)") {
		t.Fatalf("target lost inherited admin access: %s", sd.String())
	}
	t.Logf("target ACL: %s", sd.String())
}

func TestCommitRetainsResultWhenUploadInUse(t *testing.T) {
	h := newHarness(t)
	wantStatus(t, h.do(http.MethodPut, "/files/uploads/in-use", q("offset", "0"), strings.NewReader("content"), nil), http.StatusOK)
	rec, _, err := h.st.GetUpload("in-use")
	if err != nil {
		t.Fatal(err)
	}
	// Go's normal reader shares read and write, but denies deletion.
	// Copy and placement succeed while deleting this upload cannot.
	f, err := os.Open(rec.TempPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	target := h.path("file.txt")
	res := h.commitDirect(h.ctx(), "in-use", map[string]any{"path": target, "overwrite": false})
	if res.Code != http.StatusOK {
		t.Fatalf("commit with locked source = %d %s", res.Code, res.Body)
	}
	if _, err := os.Stat(rec.TempPath); err != nil {
		t.Fatalf("expected locked upload to remain for cleanup: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	again := h.commitDirect(h.ctx(), "in-use", map[string]any{"path": target, "overwrite": false})
	if again.Code != http.StatusOK || again.Body.String() != res.Body.String() {
		t.Fatalf("repeat = %d %s", again.Code, again.Body)
	}
	h.clock.Add(DefaultUploadTTL + 1)
	h.svc.sweep(h.ctx())
	if _, err := os.Stat(rec.TempPath); !os.IsNotExist(err) {
		t.Fatalf("janitor left source after unlock: %v", err)
	}
}
