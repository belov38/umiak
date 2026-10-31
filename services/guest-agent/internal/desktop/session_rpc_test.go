package desktop

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// TestSessionTransportPreservesPrimitives implements the desktop adapter boundary.
func TestSessionTransportPreservesPrimitives(t *testing.T) {
	f := &fakeSession{}
	server := httptest.NewServer(SessionHandler(f))
	defer server.Close()
	s := &RemoteSession{Client: server.Client(), URL: server.URL}
	ctx := context.Background()
	size, cursor, err := s.State(ctx)
	if err != nil || size.Width != 1920 || cursor.Y != 200 {
		t.Fatalf("state %v %v %v", size, cursor, err)
	}
	img, err := s.Capture(ctx, true)
	if err != nil || img.Bounds().Dx() != 1920 {
		t.Fatalf("capture: %v", err)
	}
	if err = s.Input(ctx, &v1.DesktopAction{Type: "click"}); err != nil || f.actions != 1 {
		t.Fatalf("input: %v", err)
	}
	if err = s.ClipboardSet(ctx, "Привет 世界"); err != nil {
		t.Fatal(err)
	}
	large := strings.Repeat("\x00", 1<<20)
	if err = s.ClipboardSet(ctx, large); err != nil {
		t.Fatal("escaped clipboard", err)
	}
	if got, _, err := s.ClipboardGet(ctx); err != nil || got != large {
		t.Fatal("escaped clipboard read", err)
	}
	_ = s.ClipboardSet(ctx, "Привет 世界")
	text, has, err := s.ClipboardGet(ctx)
	if err != nil || !has || text != "Привет 世界" {
		t.Fatalf("clipboard %q %v %v", text, has, err)
	}
}
