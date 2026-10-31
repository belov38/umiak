package desktop

import (
	"context"
	"errors"
	"image"
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/protobuf/proto"

	"connectrpc.com/connect"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
)

// Fake session and streamer keep desktop tests independent of X11 and Sunshine.
type fakeSession struct {
	actions int
	text    string
	failAt  int
}

// State returns the live screen dimensions and pointer.
func (*fakeSession) State(context.Context) (*v1.DesktopSize, *v1.DesktopPoint, error) {
	return &v1.DesktopSize{Width: 1920, Height: 1080}, &v1.DesktopPoint{X: 100, Y: 200}, nil
}

// Capture captures the desktop independently of video streaming.
func (*fakeSession) Capture(context.Context, bool) (image.Image, error) {
	return image.NewRGBA(image.Rect(0, 0, 1920, 1080)), nil
}

// Input dispatches a validated input action.
func (f *fakeSession) Input(_ context.Context, _ *v1.DesktopAction) error {
	f.actions++
	if f.failAt > 0 && f.actions == f.failAt {
		return errors.New("input refused")
	}
	return nil
}

// ClipboardGet reads the interactive text selection.
func (f *fakeSession) ClipboardGet(context.Context) (string, bool, error) {
	return f.text, f.text != "", nil
}

// ClipboardSet owns the interactive text selection.
func (f *fakeSession) ClipboardSet(_ context.Context, s string) error { f.text = s; return nil }

type fakeStreamer struct {
	creds Credentials
	stops int
}

// Open starts and pairs the pinned upstream streaming stack.
func (f *fakeStreamer) Open(_ context.Context, c Credentials, _ []*v1.DesktopIceServer) (string, string, error) {
	f.creds = c
	return "host", "desktop", nil
}

// Stop stops both streaming services.
func (f *fakeStreamer) Stop(context.Context) error { f.stops++; return nil }

// EndStreams implements the desktop adapter boundary.
func (f *fakeStreamer) EndStreams(context.Context) error { return nil }

func service(t *testing.T, id string, dir string, session *fakeSession, stream *fakeStreamer, emit *events.Recorder) *Service {
	t.Helper()
	s, e := New(Options{Enabled: true, Identity: id, Dir: dir, Session: session, Streamer: stream, Emit: emit})
	if e != nil {
		t.Fatal(e)
	}
	return s
}

// TestIdentityCredentialsAndEpoch implements the desktop adapter boundary.
func TestIdentityCredentialsAndEpoch(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	f := &fakeStreamer{}
	rec := &events.Recorder{}
	s := service(t, "machine-a", dir, &fakeSession{}, f, rec)
	_, e := s.Configure(ctx, connect.NewRequest(&v1.DesktopConfigureRequest{AuthEpoch: 5, IceServers: []*v1.DesktopIceServer{{Urls: []string{"turn:turn.example:3478"}, Username: "expiry:sb", Credential: "test"}}}))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Open(ctx, connect.NewRequest(&v1.DesktopOpenRequest{})); e != nil {
		t.Fatal(e)
	}
	first := f.creds
	if first.Password == "" || first.Username == "" {
		t.Fatal("empty credentials")
	}
	info, e := os.Stat(filepath.Join(dir, "identity.json"))
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private state mode: %v %v", info, e)
	}
	restarted := service(t, "machine-a", dir, &fakeSession{}, f, rec)
	_, _ = restarted.Open(ctx, connect.NewRequest(&v1.DesktopOpenRequest{}))
	if f.creds != first {
		t.Fatal("restart rotated identity credentials")
	}
	fork := service(t, "machine-b", dir, &fakeSession{}, f, rec)
	_, _ = fork.Open(ctx, connect.NewRequest(&v1.DesktopOpenRequest{}))
	if f.creds == first {
		t.Fatal("fork reused credentials")
	}
	if _, e = os.Stat(filepath.Join(dir, "ice-servers.json")); !os.IsNotExist(e) {
		t.Fatal("fork retained TURN credentials")
	}
	s.StreamingChanged(1)
	if s.Streams() != 1 {
		t.Fatal("missing activity")
	}
	if e = s.PrepareStop(ctx); e != nil {
		t.Fatal(e)
	}
	st, _ := s.Status(ctx, connect.NewRequest(&v1.DesktopStatusRequest{}))
	if st.Msg.AuthEpoch != 6 || s.Streams() != 0 {
		t.Fatalf("stop: %v", st.Msg)
	}
}

// TestActRejectsInvalidScreenshotBeforeInput implements the desktop adapter boundary.
func TestActRejectsInvalidScreenshotBeforeInput(t *testing.T) {
	for _, shot := range []*v1.DesktopScreenshotRequest{
		{Format: "gif"}, {Quality: 101}, {Region: &v1.DesktopRegion{X: 1919, Y: 0, Width: 2, Height: 1}},
	} {
		f := &fakeSession{}
		s := service(t, "machine", t.TempDir(), f, &fakeStreamer{}, &events.Recorder{})
		_, err := s.Act(context.Background(), connect.NewRequest(&v1.DesktopActRequest{Actions: []*v1.DesktopAction{{Type: "type", Text: "must not type"}}, Screenshot: shot}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument || f.actions != 0 {
			t.Fatalf("err=%v inputs=%d", err, f.actions)
		}
	}
}

// TestInvalidActionCarriesStructuredIndex implements the desktop adapter boundary.
func TestInvalidActionCarriesStructuredIndex(t *testing.T) {
	_, err := validateActions(&v1.DesktopActRequest{Actions: []*v1.DesktopAction{{Type: "wait"}, {Type: "key", Keys: []string{"unknown"}}}}, &v1.DesktopSize{Width: 1920, Height: 1080})
	cerr := new(connect.Error)
	if !errors.As(err, &cerr) {
		t.Fatalf("expected Connect error, got %v", err)
	}
	for _, detail := range cerr.Details() {
		value, e := detail.Value()
		if e != nil {
			t.Fatal(e)
		}
		if action, ok := value.(*v1.DesktopActionFailure); ok {
			if action.Index != 1 || action.Reason != "unknown key" {
				t.Fatalf("wrong detail: %v", action)
			}
			return
		}
	}
	t.Fatal("missing structured action failure")
}

// TestFailedActionCarriesPartialProgress implements the desktop adapter boundary.
func TestFailedActionCarriesPartialProgress(t *testing.T) {
	f := &fakeSession{failAt: 3}
	s := service(t, "machine", t.TempDir(), f, &fakeStreamer{}, &events.Recorder{})
	_, err := s.Act(context.Background(), connect.NewRequest(&v1.DesktopActRequest{Actions: []*v1.DesktopAction{{Type: "click"}, {Type: "click"}, {Type: "click"}, {Type: "click"}}}))
	cerr := new(connect.Error)
	if !errors.As(err, &cerr) {
		t.Fatalf("expected Connect error, got %v", err)
	}
	if f.actions != 3 {
		t.Fatalf("input did not stop: %d", f.actions)
	}
	for _, detail := range cerr.Details() {
		value, e := detail.Value()
		if e != nil {
			t.Fatal(e)
		}
		if action, ok := value.(*v1.DesktopActionFailure); ok {
			if action.Index != 2 || action.Completed != 2 {
				t.Fatalf("wrong partial progress: %v", action)
			}
			return
		}
	}
	t.Fatal("missing partial progress")
}

// TestValidateEntireBatchBeforeInput implements the desktop adapter boundary.
func TestValidateEntireBatchBeforeInput(t *testing.T) {
	f := &fakeSession{}
	s := service(t, "a", t.TempDir(), f, &fakeStreamer{}, nil)
	x, y := int32(10), int32(10)
	bad := int32(1920)
	_, e := s.Act(context.Background(), connect.NewRequest(&v1.DesktopActRequest{Actions: []*v1.DesktopAction{{Type: "move", X: &x, Y: &y}, {Type: "move", X: &bad, Y: &y}}}))
	if e == nil || f.actions != 0 {
		t.Fatalf("invalid batch executed %d actions: %v", f.actions, e)
	}
}

// TestScreenshotAndClipboardWithoutStreamer implements the desktop adapter boundary.
func TestScreenshotAndClipboardWithoutStreamer(t *testing.T) {
	s := service(t, "a", t.TempDir(), &fakeSession{}, &fakeStreamer{}, nil)
	ctx := context.Background()
	shot, e := s.Screenshot(ctx, connect.NewRequest(&v1.DesktopScreenshotRequest{Format: "png", MaxWidth: 1280, MaxHeight: 720}))
	if e != nil {
		t.Fatal(e)
	}
	if shot.Msg.Screen.Width != 1920 || shot.Msg.Image.Width != 1280 || len(shot.Msg.Data) == 0 {
		t.Fatalf("shot %v", shot.Msg)
	}
	_, e = s.SetClipboard(ctx, connect.NewRequest(&v1.DesktopSetClipboardRequest{Text: "Привет 🌍"}))
	if e != nil {
		t.Fatal(e)
	}
	clip, e := s.GetClipboard(ctx, connect.NewRequest(&v1.DesktopGetClipboardRequest{}))
	if e != nil || clip.Msg.Text != "Привет 🌍" || !clip.Msg.HasText {
		t.Fatalf("clipboard %v %v", clip, e)
	}
}

// TestInvalidActionLimits implements the desktop adapter boundary.
func TestInvalidActionLimits(t *testing.T) {
	screen := &v1.DesktopSize{Width: 1920, Height: 1080}
	for _, a := range []*v1.DesktopAction{{Type: "unknown"}, {Type: "key", Keys: []string{"made-up"}}, {Type: "click", Modifiers: []string{"enter"}}, {Type: "wait", Ms: 10001}, {Type: "type", DelayMs: proto.Uint32(101)}, {Type: "drag", Path: []*v1.DesktopPoint{{X: 0, Y: 0}}}} {
		if _, err := validateActions(&v1.DesktopActRequest{Actions: []*v1.DesktopAction{a}}, screen); err == nil {
			t.Errorf("accepted %v", a)
		}
	}
	req := &v1.DesktopActRequest{Actions: []*v1.DesktopAction{{Type: "move", X: proto.Int32(640), Y: proto.Int32(360)}}, CoordinateSpace: &v1.DesktopSize{Width: 1280, Height: 720}}
	actions, err := validateActions(req, screen)
	if err != nil || actions[0].GetX() != 960 || actions[0].GetY() != 540 {
		t.Fatalf("scale: %v %v", actions, err)
	}
	if req.Actions[0].GetX() != 640 {
		t.Fatal("mutated caller coordinates")
	}
}
