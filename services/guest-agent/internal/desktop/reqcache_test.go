package desktop

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/reqcache"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// TestActReplayKeepsScreenshotsOutOfTheStore: a repeated Act does not repeat
// input, still answers with a screenshot, and the stored outcome has no image.
func TestActReplayKeepsScreenshotsOutOfTheStore(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "state.db"), store.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	cache := reqcache.NewCache(st)
	session := &fakeSession{}
	s, err := New(Options{Enabled: true, Identity: "a", Dir: t.TempDir(), Session: session, Streamer: &fakeStreamer{}, HandlerOptions: cache.Options()})
	if err != nil {
		t.Fatal(err)
	}
	cache.Scrub(agentv1connect.DesktopActProcedure, s.ActScrubber())
	path, h := s.Handler()
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := agentv1connect.NewDesktopClient(srv.Client(), srv.URL)

	act := func() *v1.DesktopActResponse {
		t.Helper()
		req := connect.NewRequest(&v1.DesktopActRequest{
			Actions:    []*v1.DesktopAction{{Type: "type", Text: "id"}},
			Screenshot: &v1.DesktopScreenshotRequest{Format: "png", MaxWidth: 64},
		})
		req.Header().Set(wire.HeaderRequestID, "01J0000000000000000000ACT1")
		res, err := client.Act(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg
	}
	first, again := act(), act()
	if session.actions != 1 {
		t.Fatalf("input ran %d times, want 1", session.actions)
	}
	for _, r := range []*v1.DesktopActResponse{first, again} {
		if r.Completed != 1 || r.Screenshot == nil || !bytes.HasPrefix(r.Screenshot.Data, []byte("\x89PNG")) {
			t.Fatalf("response without the action result or a fresh screenshot: %+v", r)
		}
	}
	rec, found, err := st.GetRequest("01J0000000000000000000ACT1")
	if err != nil || !found {
		t.Fatalf("stored outcome: found=%v err=%v", found, err)
	}
	if bytes.Contains(rec.Response, []byte("\x89PNG")) || len(rec.Response) > 64 {
		t.Fatalf("stored Act outcome keeps image data (%d bytes)", len(rec.Response))
	}
}
