package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestLayerDownloadRetriesAndReusesVerifiedChunks(t *testing.T) {
	body := []byte("fixture compressed chunk")
	sum := sha256.Sum256(body)
	blob := layerBlob{SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(body))}
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/blobs/sha256/"+blob.SHA256 {
			t.Error("unexpected path")
		}
		if requests.Add(1) == 1 {
			w.WriteHeader(429)
			return
		}
		_, _ = w.Write(body)
	}))
	defer server.Close()
	dir := t.TempDir()
	wait := func(context.Context, time.Duration) error { return nil }
	p, e := downloadLayerBlob(t.Context(), server.Client(), server.URL, dir, blob, wait)
	if e != nil {
		t.Fatal(e)
	}
	if requests.Load() != 2 {
		t.Fatal("did not retry")
	}
	got, e := os.ReadFile(p) //nolint:gosec // test-owned digest path
	if e != nil || string(got) != string(body) {
		t.Fatal(e)
	}
	if _, e = downloadLayerBlob(t.Context(), server.Client(), server.URL, dir, blob, wait); e != nil || requests.Load() != 2 {
		t.Fatal("did not reuse verified chunk", e)
	}
	if e = os.WriteFile(p, []byte("bad"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = downloadLayerBlob(t.Context(), server.Client(), server.URL, dir, blob, wait); e != nil || requests.Load() != 3 {
		t.Fatal("did not repair corrupt cache", e)
	}
}
func TestLayerDownloadRejectsHashMismatchRedirectAndSymlink(t *testing.T) {
	body := []byte("fixture")
	sum := sha256.Sum256(body)
	blob := layerBlob{SHA256: hex.EncodeToString(sum[:]), SizeBytes: 7}
	wait := func(context.Context, time.Duration) error { return nil }
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "changed") }))
	defer server.Close()
	if _, e := downloadLayerBlob(t.Context(), server.Client(), server.URL, t.TempDir(), blob, wait); e == nil {
		t.Fatal("accepted changed bytes")
	}
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if e := os.WriteFile(outside, body, 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Symlink(outside, filepath.Join(dir, blob.SHA256)); e != nil {
		t.Fatal(e)
	}
	if _, e := downloadLayerBlob(t.Context(), server.Client(), server.URL, dir, blob, wait); e == nil {
		t.Fatal("accepted symlink cache")
	}
	redirect := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://untrusted.invalid/chunk", http.StatusFound)
	}))
	defer redirect.Close()
	if _, e := downloadLayerBlob(t.Context(), redirect.Client(), redirect.URL, t.TempDir(), blob, wait); e == nil {
		t.Fatal("followed outside origin")
	}
}
