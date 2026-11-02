package files

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
)

// otherDevice returns a fresh directory on another filesystem than base
// (/dev/shm is a tmpfs in containers), or skips the test.
func otherDevice(t *testing.T, base string) string {
	t.Helper()
	var a, b syscall.Stat_t
	if err := syscall.Stat(base, &a); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Stat("/dev/shm", &b); err != nil || a.Dev == b.Dev {
		t.Skip("no second filesystem at /dev/shm")
	}
	dir, err := os.MkdirTemp("/dev/shm", "umiak-files-test")
	if err != nil {
		t.Skip(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func TestUploadCrossDevice(t *testing.T) {
	h := newHarness(t)
	other := otherDevice(t, h.layout.StateDir)
	commit := func(id, dst string) *response {
		b, _ := json.Marshal(map[string]any{"path": dst})
		return h.do(http.MethodPost, "/files/uploads/"+id+"/commit", nil, bytes.NewReader(b), nil)
	}

	// A hint on another filesystem keeps the temporary file in the target
	// directory.
	dst1 := filepath.Join(other, "hinted.bin")
	res := h.do(http.MethodPut, "/files/uploads/hinted", q("offset", "0", "path", dst1), strings.NewReader("hinted"), nil)
	wantStatus(t, res, http.StatusOK)
	if _, err := os.Stat(filepath.Join(other, ".umiak-upload-hinted")); err != nil {
		t.Fatalf("temp file not next to the target: %v", err)
	}
	wantStatus(t, commit("hinted", dst1), http.StatusOK)
	if b, _ := os.ReadFile(dst1); string(b) != "hinted" {
		t.Fatalf("content %q", b)
	}

	// Without a hint the file lives in UploadsDir and the commit copies it.
	dst2 := filepath.Join(other, "copied.bin")
	res = h.do(http.MethodPut, "/files/uploads/plain", q("offset", "0"), strings.NewReader("copied"), nil)
	wantStatus(t, res, http.StatusOK)
	wantStatus(t, commit("plain", dst2), http.StatusOK)
	if b, _ := os.ReadFile(dst2); string(b) != "copied" {
		t.Fatalf("content %q", b)
	}
	if _, err := os.Stat(filepath.Join(h.layout.UploadsDir, "plain")); !os.IsNotExist(err) {
		t.Fatalf("upload file kept after the copy: %v", err)
	}
	entries, _ := os.ReadDir(other)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".umiak-") {
			t.Fatalf("temporary file left: %s", e.Name())
		}
	}
}

func TestMoveCrossDevice(t *testing.T) {
	h := newHarness(t)
	other := otherDevice(t, h.root)
	ctx := h.ctx()
	src := h.writeFile("mv.txt", []byte("move me"), 0o640)
	dst := filepath.Join(other, "mv.txt")
	res, err := h.fs.Move(ctx, connect.NewRequest(&agentv1.MoveRequest{Src: src, Dst: dst}))
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "move me" || res.Msg.GetInfo().GetMode() != 0o640 {
		t.Fatalf("dst %q, info %v", b, res.Msg.GetInfo())
	}
	if _, err := os.Lstat(src); !os.IsNotExist(err) {
		t.Fatalf("src kept: %v", err)
	}
	dir := h.path("dir")
	h.writeFile("dir/f", []byte("f"), 0o644)
	_, err = h.fs.Move(ctx, connect.NewRequest(&agentv1.MoveRequest{Src: dir, Dst: filepath.Join(other, "dir")}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.CrossDevice)
}
