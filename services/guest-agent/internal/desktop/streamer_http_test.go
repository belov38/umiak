package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

type fakeStreamHost struct {
	mu            sync.Mutex
	starts, stops int
	ready         bool
	count         uint32
}

// Prepare rotates private state when the machine identity changes.
func (f *fakeStreamHost) Prepare(context.Context, Credentials, []*v1.DesktopIceServer) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reset := !f.ready
	f.ready = true
	return reset, nil
}

// Start starts both manual streaming services.
func (f *fakeStreamHost) Start(context.Context) error { f.starts++; return nil }

// Stop stops both streaming services.
func (f *fakeStreamHost) Stop(context.Context) error { f.stops++; return nil }

// RestartWeb disconnects all upstream browser sessions.
func (f *fakeStreamHost) RestartWeb(context.Context) error { return nil }

// Viewers samples observed active media clients.
func (f *fakeStreamHost) Viewers(context.Context) (uint32, error) { return f.count, nil }

// TestPinnedPairingAndReuse implements the desktop adapter boundary.
func TestPinnedPairingAndReuse(t *testing.T) {
	fixture, e := os.ReadFile("testdata/upstream/pair.ndjson")
	if e != nil {
		t.Fatal(e)
	}
	frames := strings.Split(strings.TrimSpace(string(fixture)), "\n")
	paired := make(chan struct{})
	var passwords, pins, hosts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/password":
			passwords++
			var b map[string]string
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b["newPassword"] != "private" || b["currentUsername"] != "admin" {
				t.Error("wrong Sunshine credentials")
			}
			_, _ = fmt.Fprint(w, `{"status":true}`)
		case "/api/login":
			http.SetCookie(w, &http.Cookie{Name: "sessionToken", Value: "fixture", Path: "/"})
		case "/api/user":
			if r.Method == "GET" {
				http.Error(w, "not found", 404)
			} else {
				_, _ = fmt.Fprint(w, `{"user_id":11}`)
			}
		case "/api/role/default":
			_, _ = fmt.Fprint(w, `{"id":2}`)
		case "/api/role":
			var role map[string]any
			_ = json.NewDecoder(r.Body).Decode(&role)
			if role["permissions"].(map[string]any)["allow_add_hosts"] != false {
				t.Error("viewer may add hosts")
			}
		case "/api/hosts":
			_, _ = fmt.Fprint(w, `{"hosts":[]}`)
		case "/api/host":
			if r.Method == "POST" {
				hosts++
				_, _ = fmt.Fprint(w, `{"host":{"host_id":7,"paired":"NotPaired"}}`)
			}
		case "/api/pair":
			_, _ = fmt.Fprint(w, frames[0]+"\n")
			w.(http.Flusher).Flush()
			<-paired
			_, _ = fmt.Fprint(w, frames[1]+"\n")
		case "/api/pin":
			if r.Method == "GET" {
				_, _ = fmt.Fprint(w, `{"pairings":[{"id":"0123456789abcdef0123456789abcdef","address":"127.0.0.1","name":"Moonlight"}]}`)
			} else {
				pins++
				var b map[string]string
				_ = json.NewDecoder(r.Body).Decode(&b)
				if b["pairing_id"] != "0123456789abcdef0123456789abcdef" || b["pin"] != "4821" {
					t.Error("wrong pairing request")
				}
				close(paired)
				_, _ = fmt.Fprint(w, `{"status":true}`)
			}
		case "/api/apps":
			_, _ = fmt.Fprint(w, `{"apps":[{"app_id":1,"title":"Desktop"}]}`)
		case "/api/apps/close":
			_, _ = fmt.Fprint(w, `{"status":true}`)
		default:
			t.Errorf("unexpected route %s", r.URL)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	host := &fakeStreamHost{count: 2}
	s := NewHTTPStreamer(host, server.Client(), server.URL, server.URL)
	for range 2 {
		h, a, e := s.Open(context.Background(), Credentials{"admin", "private"}, nil)
		if e != nil || h != "7" || a != "1" {
			t.Fatalf("open %q %q %v", h, a, e)
		}
	}
	if pins != 1 || hosts != 1 || passwords != 1 {
		t.Fatalf("pairing repeated: %d %d %d", pins, hosts, passwords)
	}
	if n, e := s.Viewers(context.Background()); e != nil || n != 2 {
		t.Fatalf("viewers %d %v", n, e)
	}
	if e := s.EndStreams(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := s.Stop(context.Background()); e != nil || host.stops != 1 {
		t.Fatalf("stop %v", e)
	}
}

// TestViewerFixtures implements the desktop adapter boundary.
func TestViewerFixtures(t *testing.T) {
	fixture, e := os.ReadFile("testdata/upstream/viewers.log")
	if e != nil {
		t.Fatal(e)
	}
	if n := viewerLogCount(string(fixture)); n != 1 {
		t.Fatalf("log count %d", n)
	}
	line := "udp 17 119 src=127.0.0.1 dst=127.0.0.1 sport=53555 dport=47999 src=127.0.0.1 dst=127.0.0.1 sport=47999 dport=53555 [ASSURED]"
	if n := conntrackViewers(line); n != 1 {
		t.Fatalf("conntrack count %d", n)
	}
	if n := conntrackViewers("tcp ESTABLISHED dport=48010"); n != 0 {
		t.Fatal("RTSP setup mistaken for viewer")
	}
}

func TestBootPreparesFreshUpstreamStateWithoutOpeningVideo(t *testing.T) {
	host := &fakeStreamHost{}
	stream := NewHTTPStreamer(host, &http.Client{}, "http://unused.invalid", "http://unused.invalid")
	s, e := New(Options{Enabled: true, Identity: "fork", Dir: t.TempDir(), Session: &fakeSession{}, Streamer: stream})
	if e != nil {
		t.Fatal(e)
	}
	if e = s.PrepareRuntime(context.Background()); e != nil {
		t.Fatal(e)
	}
	if !host.ready || host.starts != 0 {
		t.Fatal("boot did not rotate state independently of video")
	}
}

type blockedRoundTripper struct{ started chan struct{} }

func (t blockedRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	close(t.started)
	<-r.Context().Done()
	return nil, r.Context().Err()
}
func TestRevocationCancelsInFlightPairing(t *testing.T) {
	started := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := NewHTTPStreamer(&fakeStreamHost{}, &http.Client{Transport: blockedRoundTripper{started}}, "http://sun.test", "http://moon.test")
	service, e := New(Options{Enabled: true, Identity: "machine", Dir: t.TempDir(), Session: &fakeSession{}, Streamer: stream})
	if e != nil {
		t.Fatal(e)
	}
	opened := make(chan struct{})
	go func() { _, _ = service.Open(ctx, connect.NewRequest(&v1.DesktopOpenRequest{})); close(opened) }()
	<-started
	stopped := make(chan error, 1)
	go func() {
		_, err := service.EndStreams(ctx, connect.NewRequest(&v1.DesktopEndStreamsRequest{}))
		stopped <- err
	}()
	select {
	case e := <-stopped:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("revocation blocked behind pairing")
	}
	<-opened
}
