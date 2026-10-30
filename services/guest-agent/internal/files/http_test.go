package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

func TestDownloadRangeAndETag(t *testing.T) {
	h := newHarness(t)
	data := randomBytes(1000)
	p := h.writeFile("d/f.bin", data, 0o644)

	res := h.do(http.MethodGet, "/files", q("path", p), nil, nil)
	body := wantStatus(t, res, http.StatusOK)
	mustEqualBytes(t, "full body", body, data)
	etag := res.Header.Get("ETag")
	if !regexp.MustCompile(`^"[0-9]+-1000-[0-9]+"$`).MatchString(etag) {
		t.Fatalf("ETag = %q", etag)
	}
	if res.Header.Get("Accept-Ranges") != "bytes" || res.Header.Get("Last-Modified") == "" {
		t.Fatalf("headers %v", res.Header)
	}
	if res.Header.Get("Content-Encoding") != "" {
		t.Fatalf("Content-Encoding = %q", res.Header.Get("Content-Encoding"))
	}

	res = h.do(http.MethodGet, "/files", q("path", p), nil, http.Header{"Range": {"bytes=10-19"}})
	body = wantStatus(t, res, http.StatusPartialContent)
	mustEqualBytes(t, "range", body, data[10:20])

	res = h.do(http.MethodGet, "/files", q("path", p), nil, http.Header{"Range": {"bytes=10-19"}, "If-Range": {etag}})
	body = wantStatus(t, res, http.StatusPartialContent)
	mustEqualBytes(t, "if-range current", body, data[10:20])

	res = h.do(http.MethodGet, "/files", q("path", p), nil, http.Header{"Range": {"bytes=10-19"}, "If-Range": {`"1-2-3"`}})
	body = wantStatus(t, res, http.StatusOK)
	mustEqualBytes(t, "if-range stale", body, data)

	res = h.do(http.MethodGet, "/files", q("path", p), nil, http.Header{"Range": {"bytes=0-1,4-5"}})
	body = wantStatus(t, res, http.StatusOK)
	mustEqualBytes(t, "multi-range", body, data)

	res = h.do(http.MethodHead, "/files", q("path", p), nil, nil)
	wantStatus(t, res, http.StatusOK)
	if res.Header.Get("Content-Length") != "1000" || res.Header.Get("ETag") != etag {
		t.Fatalf("HEAD headers %v", res.Header)
	}

	// A relative path resolves under the home of the request user.
	res = h.do(http.MethodGet, "/files", q("path", "no-such-file-sbx-test"), nil, nil)
	wantError(t, res, http.StatusNotFound, errs.PathNotFound)
}

func TestDownloadDirIsDirectory(t *testing.T) {
	h := newHarness(t)
	res := h.do(http.MethodGet, "/files", q("path", h.root), nil, nil)
	wantError(t, res, http.StatusBadRequest, errs.IsDirectory)
}

func TestNotFoundRoutes(t *testing.T) {
	h := newHarness(t)
	for _, p := range []string{"/files/x", "/files/uploads", "/files/uploads/a/b", "/filesx", "/files/archive/x"} {
		res := h.do(http.MethodGet, p, nil, nil, nil)
		wantStatus(t, res, http.StatusNotFound)
	}
	res := h.do(http.MethodPost, "/files", nil, nil, nil)
	wantStatus(t, res, http.StatusMethodNotAllowed)
}

func TestPutAtomic(t *testing.T) {
	h := newHarness(t)
	p := h.path("atomic.bin")
	small := []byte("old content")
	if err := os.WriteFile(p, small, 0o644); err != nil {
		t.Fatal(err)
	}
	big := randomBytes(8 << 20)

	var stop atomic.Bool
	var bad atomic.Int64
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for !stop.Load() {
			b, err := os.ReadFile(p)
			if err != nil {
				bad.Store(-1)
				return
			}
			if len(b) != len(small) && len(b) != len(big) {
				bad.Store(int64(len(b)))
				return
			}
		}
	}()
	res := h.do(http.MethodPut, "/files", q("path", p, "mode", "0640"), bytes.NewReader(big), nil)
	body := wantStatus(t, res, http.StatusOK)
	stop.Store(true)
	wg.Wait()
	if n := bad.Load(); n != 0 {
		t.Fatalf("reader saw a partial file (len %d)", n)
	}
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	mustEqualBytes(t, "content", got, big)
	fi := fileInfo(t, body)
	if fi.GetSize() != uint64(len(big)) || fi.GetMode() != 0o640 || fi.GetPath() != p || fi.GetName() != "atomic.bin" {
		t.Fatalf("FileInfo = %v", fi)
	}
	if fi.GetUid() != h.user.UID || fi.GetGid() != h.user.GID {
		t.Fatalf("owner %d:%d, want %d:%d", fi.GetUid(), fi.GetGid(), h.user.UID, h.user.GID)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", st.Mode())
	}
	entries, _ := os.ReadDir(h.root)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".sbx-tmp-") {
			t.Fatalf("temporary file left: %s", e.Name())
		}
	}

	// make_parents defaults to true; mode defaults to 0644.
	deep := h.path("a", "b", "c.txt")
	res = h.do(http.MethodPut, "/files", q("path", deep), strings.NewReader("x"), nil)
	fi = fileInfo(t, wantStatus(t, res, http.StatusOK))
	if fi.GetMode() != 0o644 {
		t.Fatalf("default mode %o", fi.GetMode())
	}
	res = h.do(http.MethodPut, "/files", q("path", h.path("n", "x"), "make_parents", "false"), strings.NewReader("x"), nil)
	wantError(t, res, http.StatusNotFound, errs.PathNotFound)
	res = h.do(http.MethodPut, "/files", q("path", deep, "overwrite", "false"), strings.NewReader("y"), nil)
	wantError(t, res, http.StatusConflict, errs.AlreadyExists)
	res = h.do(http.MethodPut, "/files", q("path", h.root), strings.NewReader("y"), nil)
	wantError(t, res, http.StatusBadRequest, errs.IsDirectory)
}

func TestPutFollowsSymlink(t *testing.T) {
	h := newHarness(t)
	target := h.writeFile("target.txt", []byte("old"), 0o644)
	link := h.path("link.txt")
	if err := os.Symlink("target.txt", link); err != nil {
		t.Fatal(err)
	}
	res := h.do(http.MethodPut, "/files", q("path", link), strings.NewReader("new"), nil)
	wantStatus(t, res, http.StatusOK)
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("symlink replaced: %v %v", fi, err)
	}
	if b, _ := os.ReadFile(target); string(b) != "new" {
		t.Fatalf("target = %q", b)
	}
}

var offsetRE = regexp.MustCompile(`^[0-9]+$`)

func TestUploadChunksResume(t *testing.T) {
	h := newHarness(t)
	data := randomBytes(3<<20 + 123)
	c1, c2 := data[:2<<20], data[2<<20:]
	dst := h.path("up", "file.bin")
	id := "upl_01JABCDEF"

	res := h.do(http.MethodPut, "/files/uploads/"+id, q("offset", "0", "path", dst), bytes.NewReader(c1), nil)
	wantStatus(t, res, http.StatusOK)
	if got := res.Header.Get("Sbx-Upload-Offset"); got != itoa(len(c1)) {
		t.Fatalf("offset after chunk 1 = %q", got)
	}
	// The temp file lives in UploadsDir: the target is on the same device.
	if _, err := os.Stat(filepath.Join(h.layout.UploadsDir, id)); err != nil {
		t.Fatalf("temp file: %v", err)
	}

	// Wrong offset: 409 with the current offset.
	res = h.do(http.MethodPut, "/files/uploads/"+id, q("offset", "5"), bytes.NewReader(c2), nil)
	wantError(t, res, http.StatusConflict, errs.UploadOffsetMismatch)
	got := res.Header.Get("Sbx-Upload-Offset")
	if !offsetRE.MatchString(got) || got != itoa(len(c1)) {
		t.Fatalf("Sbx-Upload-Offset = %q", got)
	}
	for k := range res.Header {
		if strings.HasPrefix(strings.ToLower(k), "sbx-") && k != "Sbx-Upload-Offset" {
			t.Fatalf("unexpected header %s", k)
		}
	}
	res = h.do(http.MethodHead, "/files/uploads/"+id, nil, nil, nil)
	wantStatus(t, res, http.StatusOK)
	if res.Header.Get("Sbx-Upload-Offset") != got {
		t.Fatalf("HEAD offset = %q, want %q", res.Header.Get("Sbx-Upload-Offset"), got)
	}

	res = h.do(http.MethodPut, "/files/uploads/"+id, q("offset", got), bytes.NewReader(c2), nil)
	wantStatus(t, res, http.StatusOK)
	if res.Header.Get("Sbx-Upload-Offset") != itoa(len(data)) {
		t.Fatalf("final offset %q", res.Header.Get("Sbx-Upload-Offset"))
	}

	sum := sha256.Sum256(data)
	commit := func(id string, body map[string]any) *response {
		b, _ := json.Marshal(body)
		return h.do(http.MethodPost, "/files/uploads/"+id+"/commit", nil, bytes.NewReader(b), nil)
	}
	res = commit(id, map[string]any{"path": dst, "sha256": hex.EncodeToString(sum[:]), "mode": 0o600})
	b1 := wantStatus(t, res, http.StatusOK)
	fi := fileInfo(t, b1)
	if fi.GetSize() != uint64(len(data)) || fi.GetMode() != 0o600 || fi.GetPath() != dst {
		t.Fatalf("FileInfo %v", fi)
	}
	content, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	mustEqualBytes(t, "committed", content, data)
	if p, err := h.svc.UploadPath(id); err != nil || p != dst {
		t.Fatalf("UploadPath = %q, %v", p, err)
	}

	// A repeated commit replays the stored result, even after the file changed.
	if err := os.WriteFile(dst, []byte("changed"), 0o600); err != nil {
		t.Fatal(err)
	}
	res = commit(id, map[string]any{"path": dst})
	b2 := wantStatus(t, res, http.StatusOK)
	if !bytes.Equal(b1, b2) {
		t.Fatalf("replayed commit differs:\n%s\n%s", b1, b2)
	}

	// Checksum mismatch: 422 and the upload is gone.
	id2 := "second-upload"
	res = h.do(http.MethodPut, "/files/uploads/"+id2, q("offset", "0"), strings.NewReader("hello"), nil)
	wantStatus(t, res, http.StatusOK)
	if p, err := h.svc.UploadPath(id2); err != nil || p != filepath.Join(h.layout.UploadsDir, id2) {
		t.Fatalf("UploadPath live = %q, %v", p, err)
	}
	res = commit(id2, map[string]any{"path": h.path("x.txt"), "sha256": strings.Repeat("0", 64)})
	wantError(t, res, 422, errs.ChecksumMismatch)
	res = h.do(http.MethodHead, "/files/uploads/"+id2, nil, nil, nil)
	wantStatus(t, res, http.StatusNotFound)
	if _, err := os.Stat(filepath.Join(h.layout.UploadsDir, id2)); !os.IsNotExist(err) {
		t.Fatalf("temp file kept: %v", err)
	}
	if _, err := os.Stat(h.path("x.txt")); !os.IsNotExist(err) {
		t.Fatalf("target written on mismatch: %v", err)
	}
	res = commit(id2, map[string]any{"path": h.path("x.txt")})
	wantError(t, res, http.StatusNotFound, errs.UploadNotFound)
	if _, err := h.svc.UploadPath(id2); err == nil {
		t.Fatal("UploadPath of a deleted upload succeeded")
	}
}

func TestUploadLimitsAndCancel(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.MaxChunk = 1024 })
	res := h.do(http.MethodPut, "/files/uploads/big", q("offset", "0"), bytes.NewReader(randomBytes(1025)), nil)
	wantError(t, res, http.StatusRequestEntityTooLarge, errs.PayloadTooLarge)

	res = h.do(http.MethodPut, "/files/uploads/u1", q("offset", "0"), strings.NewReader("abc"), nil)
	wantStatus(t, res, http.StatusOK)
	// A chunk too large leaves the upload where it was.
	res = h.do(http.MethodPut, "/files/uploads/u1", q("offset", "3"), bytes.NewReader(randomBytes(2000)), nil)
	wantError(t, res, http.StatusRequestEntityTooLarge, errs.PayloadTooLarge)
	res = h.do(http.MethodHead, "/files/uploads/u1", nil, nil, nil)
	if wantStatus(t, res, http.StatusOK); res.Header.Get("Sbx-Upload-Offset") != "3" {
		t.Fatalf("offset after rejected chunk = %q", res.Header.Get("Sbx-Upload-Offset"))
	}
	res = h.do(http.MethodPut, "/files/uploads/u1", q("offset", "-1"), strings.NewReader("x"), nil)
	wantError(t, res, http.StatusBadRequest, errs.InvalidArgument)

	res = h.do(http.MethodDelete, "/files/uploads/u1", nil, nil, nil)
	wantStatus(t, res, http.StatusNoContent)
	res = h.do(http.MethodHead, "/files/uploads/u1", nil, nil, nil)
	wantStatus(t, res, http.StatusNotFound)
	if _, err := os.Stat(filepath.Join(h.layout.UploadsDir, "u1")); !os.IsNotExist(err) {
		t.Fatalf("temp file kept after cancel: %v", err)
	}
	res = h.do(http.MethodDelete, "/files/uploads/u1", nil, nil, nil)
	wantError(t, res, http.StatusNotFound, errs.UploadNotFound)
}

func TestUploadIDConfinement(t *testing.T) {
	h := newHarness(t)
	parent := filepath.Dir(h.layout.UploadsDir)
	before := listTree(t, filepath.Dir(parent))
	for _, p := range []string{
		"/files/uploads/..%2F..%2Fx",
		"/files/uploads/a%2Fb",
		"/files/uploads/a%5Cb",
		"/files/uploads/.",
		"/files/uploads/..",
		"/files/uploads/%2E%2E",
		"/files/uploads/" + strings.Repeat("a", 129),
	} {
		for _, method := range []string{http.MethodPut, http.MethodHead, http.MethodDelete} {
			res := h.do(method, p, q("offset", "0"), strings.NewReader("evil"), nil)
			if method == http.MethodHead {
				wantStatus(t, res, http.StatusBadRequest)
				continue
			}
			wantError(t, res, http.StatusBadRequest, errs.InvalidPath)
		}
		res := h.do(http.MethodPost, p+"/commit", nil, strings.NewReader(`{"path":"/tmp/x"}`), nil)
		wantError(t, res, http.StatusBadRequest, errs.InvalidPath)
	}
	after := listTree(t, filepath.Dir(parent))
	if strings.Join(before, "\n") != strings.Join(after, "\n") {
		t.Fatalf("tree changed:\nbefore %v\nafter  %v", before, after)
	}
}

// listTree returns every path under root except the state database.
func listTree(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(root, func(p string, _ os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if filepath.Base(p) != "state.db" {
			out = append(out, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestUploadQuiesced(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.DurableTimeout = 100 * time.Millisecond })
	p := h.writeFile("r.txt", []byte("read me"), 0o644)
	h.st.SetFrozen(true)
	defer h.st.SetFrozen(false)

	// Reads work while frozen.
	res := h.do(http.MethodGet, "/files", q("path", p), nil, nil)
	if string(wantStatus(t, res, http.StatusOK)) != "read me" {
		t.Fatal("read while frozen")
	}
	res = h.do(http.MethodPut, "/files/uploads/frozen", q("offset", "0"), strings.NewReader("x"), nil)
	e := wantError(t, res, http.StatusServiceUnavailable, errs.Quiesced)
	if !e.Retryable {
		t.Fatal("quiesced is not retryable")
	}
	res = h.do(http.MethodPut, "/files", q("path", h.path("w.txt")), strings.NewReader("x"), nil)
	wantError(t, res, http.StatusServiceUnavailable, errs.Quiesced)
}

func TestJanitorRemovesExpired(t *testing.T) {
	h := newHarness(t)
	res := h.do(http.MethodPut, "/files/uploads/old", q("offset", "0"), strings.NewReader("x"), nil)
	wantStatus(t, res, http.StatusOK)
	h.clock.Add(23 * time.Hour)
	res = h.do(http.MethodPut, "/files/uploads/fresh", q("offset", "0"), strings.NewReader("x"), nil)
	wantStatus(t, res, http.StatusOK)
	h.clock.Add(2 * time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h.svc.sweep(ctx)
	if _, ok, _ := h.st.GetUpload("old"); ok {
		t.Fatal("expired upload kept")
	}
	if _, err := os.Stat(filepath.Join(h.layout.UploadsDir, "old")); !os.IsNotExist(err) {
		t.Fatalf("expired temp file kept: %v", err)
	}
	if _, ok, _ := h.st.GetUpload("fresh"); !ok {
		t.Fatal("fresh upload removed")
	}
}

// commitDirect posts a commit through the handler directly with ctx.
func (h *harness) commitDirect(ctx context.Context, id string, body map[string]any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/files/uploads/"+id+"/commit", bytes.NewReader(b))
	rec := httptest.NewRecorder()
	h.svc.HTTPHandler().ServeHTTP(rec, req)
	return rec
}

func TestCommitIdempotentAfterLostResult(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.DurableTimeout = 100 * time.Millisecond })
	dst := h.path("c", "file.txt")

	// The result write fails after the move (a freeze lands in between):
	// the retry rebuilds the result from the target.
	res := h.do(http.MethodPut, "/files/uploads/lost", q("offset", "0"), strings.NewReader("content"), nil)
	wantStatus(t, res, http.StatusOK)
	h.svc.testHookAfterPlace = func() { h.st.SetFrozen(true) }
	rec := h.commitDirect(h.ctx(), "lost", map[string]any{"path": dst})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("commit during freeze = %d %s", rec.Code, rec.Body)
	}
	h.svc.testHookAfterPlace = nil
	h.st.SetFrozen(false)
	if p, err := h.svc.UploadPath("lost"); err != nil || p != dst {
		t.Fatalf("UploadPath before the retry = %q, %v", p, err)
	}
	rec = h.commitDirect(h.ctx(), "lost", map[string]any{"path": dst})
	if rec.Code != http.StatusOK {
		t.Fatalf("retry = %d %s", rec.Code, rec.Body)
	}
	fi := fileInfo(t, rec.Body.Bytes())
	if fi.GetPath() != dst || fi.GetSize() != 7 {
		t.Fatalf("FileInfo %v", fi)
	}
	first := rec.Body.String()
	rec = h.commitDirect(h.ctx(), "lost", map[string]any{"path": dst})
	if rec.Code != http.StatusOK || rec.Body.String() != first {
		t.Fatalf("replay = %d %s, want %s", rec.Code, rec.Body, first)
	}

	// A client that gives up after the move does not cost the result.
	res = h.do(http.MethodPut, "/files/uploads/gone", q("offset", "0"), strings.NewReader("other"), nil)
	wantStatus(t, res, http.StatusOK)
	ctx, cancel := context.WithCancel(h.ctx())
	h.svc.testHookAfterPlace = cancel
	dst2 := h.path("c", "other.txt")
	h.commitDirect(ctx, "gone", map[string]any{"path": dst2})
	h.svc.testHookAfterPlace = nil
	rec = h.commitDirect(h.ctx(), "gone", map[string]any{"path": dst2})
	if rec.Code != http.StatusOK {
		t.Fatalf("retry after cancel = %d %s", rec.Code, rec.Body)
	}
	if fi := fileInfo(t, rec.Body.Bytes()); fi.GetPath() != dst2 || fi.GetSize() != 5 {
		t.Fatalf("FileInfo %v", fi)
	}
	if b, _ := os.ReadFile(dst2); string(b) != "other" {
		t.Fatalf("content %q", b)
	}
}

// A chunk that arrives after a commit moved the file but lost its result
// must not drop the upload: it answers 409 with the committed size, and
// the commit retry still finds the result.
func TestPutChunkAfterLostCommit(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.DurableTimeout = 100 * time.Millisecond })
	dst := h.path("c", "file.txt")
	res := h.do(http.MethodPut, "/files/uploads/lost", q("offset", "0"), strings.NewReader("content"), nil)
	wantStatus(t, res, http.StatusOK)
	h.svc.testHookAfterPlace = func() { h.st.SetFrozen(true) }
	rec := h.commitDirect(h.ctx(), "lost", map[string]any{"path": dst})
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("commit during freeze = %d %s", rec.Code, rec.Body)
	}
	h.svc.testHookAfterPlace = nil
	h.st.SetFrozen(false)

	res = h.do(http.MethodPut, "/files/uploads/lost", q("offset", "7"), strings.NewReader("more"), nil)
	wantError(t, res, http.StatusConflict, errs.UploadOffsetMismatch)
	if got := res.Header.Get("Sbx-Upload-Offset"); got != "7" {
		t.Fatalf("Sbx-Upload-Offset = %q, want 7", got)
	}
	if _, ok, _ := h.st.GetUpload("lost"); !ok {
		t.Fatal("upload record dropped by the chunk")
	}
	rec = h.commitDirect(h.ctx(), "lost", map[string]any{"path": dst})
	if rec.Code != http.StatusOK {
		t.Fatalf("commit retry = %d %s", rec.Code, rec.Body)
	}
	if fi := fileInfo(t, rec.Body.Bytes()); fi.GetPath() != dst || fi.GetSize() != 7 {
		t.Fatalf("FileInfo %v", fi)
	}
}
