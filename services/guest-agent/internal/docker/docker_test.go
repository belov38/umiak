package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"
)

// fakeDaemon serves a minimal Docker Engine API on a unix socket.
type fakeDaemon struct {
	mu    sync.Mutex
	calls []string // "METHOD path?query"
}

func (d *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	call := r.Method + " " + r.URL.EscapedPath()
	if r.URL.RawQuery != "" {
		call += "?" + r.URL.RawQuery
	}
	d.calls = append(d.calls, call)
	type ctr struct {
		ID    string `json:"Id"`
		State string `json:"State"`
	}
	writeErr := func(status int, msg string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": msg})
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/_ping":
		_, _ = w.Write([]byte("OK"))
	case r.Method == http.MethodGet && r.URL.Path == "/containers/json":
		all := []ctr{{"a1", "running"}, {"b2", "paused"}, {"c3", "running"}, {"d4", "restarting"}}
		var out []ctr
		if f := r.URL.Query().Get("filters"); f != "" {
			var filters map[string][]string
			if err := json.Unmarshal([]byte(f), &filters); err != nil {
				writeErr(http.StatusBadRequest, "bad filters")
				return
			}
			for _, c := range all {
				if slices.Contains(filters["status"], c.State) {
					out = append(out, c)
				}
			}
		} else {
			out = all
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	case r.Method == http.MethodPost && r.URL.Path == "/containers/a1/pause":
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && r.URL.Path == "/containers/a1/unpause":
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && r.URL.Path == "/containers/b2/unpause":
		writeErr(http.StatusConflict, "Container b2 is not paused")
	default:
		writeErr(http.StatusNotFound, "No such container")
	}
}

func (d *fakeDaemon) Calls() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.calls)
}

// startDaemon serves d on a unix socket in a short temporary directory (the
// macOS sun_path limit is 104 bytes, t.TempDir() can exceed it).
func startDaemon(t *testing.T, d http.Handler) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "dk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "d.sock")
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(d)
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return sock
}

func TestClientOverUnixSocket(t *testing.T) {
	d := &fakeDaemon{}
	c := &Client{Socket: startDaemon(t, d)}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := c.Ping(ctx); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	running, err := c.Running(ctx)
	if err != nil {
		t.Fatalf("Running: %v", err)
	}
	if want := []string{"a1", "c3"}; !slices.Equal(running, want) {
		t.Errorf("Running = %v, want %v", running, want)
	}
	paused, err := c.Paused(ctx)
	if err != nil {
		t.Fatalf("Paused: %v", err)
	}
	if want := []string{"b2"}; !slices.Equal(paused, want) {
		t.Errorf("Paused = %v, want %v", paused, want)
	}
	if err := c.Pause(ctx, "a1"); err != nil {
		t.Fatalf("Pause: %v", err)
	}
	if err := c.Unpause(ctx, "a1"); err != nil {
		t.Fatalf("Unpause: %v", err)
	}

	err = c.Unpause(ctx, "b2")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusConflict || apiErr.Message != "Container b2 is not paused" {
		t.Errorf("Unpause(b2) = %v, want APIError 409 with message", err)
	}
	if !IsNotPaused(err) {
		t.Errorf("IsNotPaused(%v) = false", err)
	}
	err = c.Pause(ctx, "zz")
	if !IsNotFound(err) {
		t.Errorf("Pause(zz) = %v, want not found", err)
	}

	want := []string{
		"GET /_ping",
		"GET /containers/json",
		`GET /containers/json?filters=%7B%22status%22%3A%5B%22paused%22%5D%7D`,
		"POST /containers/a1/pause",
		"POST /containers/a1/unpause",
		"POST /containers/b2/unpause",
		"POST /containers/zz/pause",
	}
	if got := d.Calls(); !slices.Equal(got, want) {
		t.Errorf("calls:\n got %q\nwant %q", got, want)
	}
}

func TestClientNoDaemon(t *testing.T) {
	dir, err := os.MkdirTemp("", "dk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	c := &Client{Socket: filepath.Join(dir, "missing.sock")}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := c.Running(ctx); !errors.Is(err, ErrNoDaemon) {
		t.Errorf("Running without a daemon = %v, want ErrNoDaemon", err)
	}
}

func TestPathEscapesID(t *testing.T) {
	d := &fakeDaemon{}
	c := &Client{Socket: startDaemon(t, d)}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.Pause(ctx, "../x")
	if got := d.Calls(); len(got) != 1 || got[0] != "POST /containers/..%2Fx/pause" {
		t.Errorf("calls = %q, want the id as one escaped segment", got)
	}
	if err := c.Pause(ctx, ""); err == nil {
		t.Error("Pause with an empty id succeeded")
	}
}
