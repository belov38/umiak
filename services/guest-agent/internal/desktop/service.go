// Package desktop owns per-identity streamer state and desktop RPCs.
package desktop

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"golang.org/x/image/draw"
	"google.golang.org/protobuf/proto"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/reqcache"
)

// Session is implemented by the interactive session helper, never the streamer.
type Session interface {
	State(context.Context) (*v1.DesktopSize, *v1.DesktopPoint, error)
	Capture(context.Context, bool) (image.Image, error)
	Input(context.Context, *v1.DesktopAction) error
	ClipboardGet(context.Context) (string, bool, error)
	ClipboardSet(context.Context, string) error
}

// Credentials are fresh random secrets for one machine identity.
type Credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// Streamer isolates upstream pairing and stream detection until the pve spike.
type Streamer interface {
	Open(context.Context, Credentials, []*v1.DesktopIceServer) (hostID, appID string, err error)
	Stop(context.Context) error
	EndStreams(context.Context) error
}

// Options injects the OS adapters. Nil adapters fail closed.
type Options struct {
	Enabled        bool
	Identity       string
	Dir            string
	Session        Session
	Streamer       Streamer
	Emit           events.Emitter
	HandlerOptions []connect.HandlerOption
	// Now is the clock of viewer activity. Default time.Now.
	Now func() time.Time
}
type identityState struct {
	Identity    string      `json:"identity"`
	Credentials Credentials `json:"credentials"`
	AuthEpoch   uint64      `json:"authEpoch"`
	Stopped     bool        `json:"stopped"`
}

// Service implements Desktop; mutations and input have independent serialization.
type Service struct {
	agentv1connect.UnimplementedDesktopHandler
	opts             Options
	mu               sync.Mutex
	state            identityState
	ice              []*v1.DesktopIceServer
	running          bool
	streamGeneration uint64
	streams          atomic.Uint32
	input            chan struct{}
	activity         viewerActivity
}

// New opens private state, rotating all credentials if the identity changed.
func New(o Options) (*Service, error) {
	if o.Streamer == nil {
		o.Streamer = PendingStreamer{}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	s := &Service{opts: o, input: make(chan struct{}, 1)}
	s.activity.touch(o.Now())
	if !o.Enabled {
		return s, nil
	}
	if o.Identity == "" || o.Dir == "" {
		return nil, errors.New("desktop: identity and state directory are required")
	}
	if err := os.MkdirAll(o.Dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(o.Dir, 0700); err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(o.Dir, "identity.json"))
	if err == nil {
		if err = json.Unmarshal(b, &s.state); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if s.state.Identity != o.Identity {
		s.state = identityState{Identity: o.Identity, Credentials: Credentials{Username: randomSecret(), Password: randomSecret()}, AuthEpoch: 1}
		// Identity changes must not retain pairing databases or TURN credentials.
		entries, e := os.ReadDir(o.Dir)
		if e != nil {
			return nil, e
		}
		for _, entry := range entries {
			if e = os.RemoveAll(filepath.Join(o.Dir, entry.Name())); e != nil {
				return nil, e
			}
		}
		if err = s.save(); err != nil {
			return nil, err
		}
	} else {
		b, err = os.ReadFile(filepath.Join(o.Dir, "ice-servers.json"))
		if err == nil {
			if err = json.Unmarshal(b, &s.ice); err != nil {
				return nil, err
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	return s, nil
}
func (s *Service) now() time.Time { return s.opts.Now() }
func randomSecret() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func (s *Service) save() error {
	b, err := json.Marshal(s.state)
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(filepath.Join(s.opts.Dir, "identity.json"), b, 0600)
}
func failure(code connect.Code, detail string) error { return errs.New(code, detail, detail) }
func (s *Service) supported() error {
	if !s.opts.Enabled {
		return failure(connect.CodeFailedPrecondition, "desktop_unsupported")
	}
	return nil
}
func (s *Service) session(ctx context.Context) (*v1.DesktopSize, *v1.DesktopPoint, error) {
	if err := s.supported(); err != nil {
		return nil, nil, err
	}
	if s.opts.Session == nil {
		return nil, nil, failure(connect.CodeUnavailable, "desktop_not_ready")
	}
	screen, cursor, err := s.opts.Session.State(ctx)
	if err != nil || screen.GetWidth() == 0 || screen.GetHeight() == 0 {
		return nil, nil, failure(connect.CodeUnavailable, "desktop_not_ready")
	}
	return screen, cursor, nil
}

// Handler includes the request cache options supplied by the agent.
func (s *Service) Handler() (string, http.Handler) {
	return agentv1connect.NewDesktopHandler(s, append(s.opts.HandlerOptions, connect.WithReadMaxBytes(32<<20), connect.WithSendMaxBytes(32<<20))...)
}

// Status reports real session readiness; a missing adapter is never ready.
func (s *Service) Status(ctx context.Context, _ *connect.Request[v1.DesktopStatusRequest]) (*connect.Response[v1.DesktopStatusResponse], error) {
	if err := s.supported(); err != nil {
		return nil, err
	}
	screen, cursor, err := s.session(ctx)
	state, reason := "ready", ""
	if err != nil {
		state, reason = "starting", "desktop_not_ready"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return connect.NewResponse(&v1.DesktopStatusResponse{State: state, Reason: reason, Screen: screen, Cursor: cursor, Running: s.running, DesktopStreams: s.Streams(), AuthEpoch: s.state.AuthEpoch}), nil
}

// Configure atomically installs issued TURN credentials, rejecting stale epochs.
func (s *Service) Configure(ctx context.Context, r *connect.Request[v1.DesktopConfigureRequest]) (*connect.Response[v1.DesktopConfigureResponse], error) {
	if err := s.supported(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Msg.AuthEpoch < s.state.AuthEpoch {
		return nil, failure(connect.CodeFailedPrecondition, "desktop_epoch_stale")
	}
	for _, ice := range r.Msg.IceServers {
		if len(ice.GetUrls()) == 0 || ice.GetUsername() == "" || ice.GetCredential() == "" {
			return nil, failure(connect.CodeInvalidArgument, "invalid_argument")
		}
	}
	b, err := json.Marshal(r.Msg.IceServers)
	if err != nil {
		return nil, err
	}
	if err = fsutil.WriteFileAtomic(filepath.Join(s.opts.Dir, "ice-servers.json"), b, 0600); err != nil {
		return nil, err
	}
	s.ice = make([]*v1.DesktopIceServer, len(r.Msg.IceServers))
	for i, ice := range r.Msg.IceServers {
		s.ice[i] = proto.Clone(ice).(*v1.DesktopIceServer)
	}
	s.state.AuthEpoch = r.Msg.AuthEpoch
	s.state.Stopped = false
	if adapter, ok := s.opts.Streamer.(interface {
		Configure(context.Context, []*v1.DesktopIceServer) error
	}); ok {
		if err = adapter.Configure(ctx, s.ice); err != nil {
			return nil, err
		}
	}
	if err = s.save(); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.DesktopConfigureResponse{}), nil
}

// Open delegates upstream details without exposing credentials to callers.
func (s *Service) Open(ctx context.Context, _ *connect.Request[v1.DesktopOpenRequest]) (*connect.Response[v1.DesktopOpenResponse], error) {
	if _, _, err := s.session(ctx); err != nil {
		return nil, err
	}
	s.activity.touch(s.now())
	s.mu.Lock()
	credentials, ice, generation := s.state.Credentials, s.ice, s.streamGeneration
	s.mu.Unlock()
	if s.opts.Streamer == nil {
		return nil, failure(connect.CodeUnavailable, "streamer_failed")
	}
	host, app, err := s.opts.Streamer.Open(ctx, credentials, ice)
	if err != nil {
		return nil, failure(connect.CodeUnavailable, "streamer_failed")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if generation != s.streamGeneration {
		return nil, failure(connect.CodeUnavailable, "streamer_failed")
	}
	s.running = true
	s.activity.touch(s.now())
	return connect.NewResponse(&v1.DesktopOpenResponse{HostId: host, AppId: app}), nil
}

// Streams is used by both event sampling and System/Activity.
func (s *Service) Streams() uint32 { return s.streams.Load() }

// StreamingChanged is called by the OS streamer adapter on observed transitions.
func (s *Service) StreamingChanged(count uint32) {
	if s.streams.Swap(count) != count && s.opts.Emit != nil {
		s.opts.Emit.Emit("desktop.streaming_changed", &v1.DesktopStreamingChanged{Streaming: count > 0, Count: count})
	}
}

// StopStreamer stops video processes without advancing the sandbox epoch.
func (s *Service) StopStreamer(ctx context.Context, _ *connect.Request[v1.DesktopStopStreamerRequest]) (*connect.Response[v1.DesktopStopStreamerResponse], error) {
	if err := s.supported(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.streamGeneration++
	s.running = false
	s.mu.Unlock()
	if s.opts.Streamer != nil {
		if err := s.opts.Streamer.Stop(ctx); err != nil {
			return nil, err
		}
	}
	s.StreamingChanged(0)
	return connect.NewResponse(&v1.DesktopStopStreamerResponse{}), nil
}

// EndStreams disconnects viewers while leaving the session alive.
func (s *Service) EndStreams(ctx context.Context, _ *connect.Request[v1.DesktopEndStreamsRequest]) (*connect.Response[v1.DesktopEndStreamsResponse], error) {
	if err := s.supported(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.streamGeneration++
	s.mu.Unlock()
	if s.opts.Streamer != nil {
		if err := s.opts.Streamer.EndStreams(ctx); err != nil {
			return nil, err
		}
	}
	s.StreamingChanged(0)
	return connect.NewResponse(&v1.DesktopEndStreamsResponse{}), nil
}

// PrepareStop advances the local epoch once and stops all streams before poweroff.
func (s *Service) PrepareStop(ctx context.Context) error {
	if !s.opts.Enabled {
		return nil
	}
	if _, err := s.StopStreamer(ctx, connect.NewRequest(&v1.DesktopStopStreamerRequest{})); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.state.Stopped {
		s.state.AuthEpoch++
		s.state.Stopped = true
	}
	return s.save()
}

// Screenshot captures, crops and scales the interactive session.
func (s *Service) Screenshot(ctx context.Context, r *connect.Request[v1.DesktopScreenshotRequest]) (*connect.Response[v1.DesktopScreenshotResponse], error) {
	screen, cursor, err := s.session(ctx)
	if err != nil {
		return nil, err
	}
	q := r.Msg
	if err = validateScreenshot(q, screen); err != nil {
		return nil, err
	}
	format := q.Format
	if format == "" {
		format = "png"
	}
	if format != "png" && format != "jpeg" || q.Quality > 100 {
		return nil, failure(connect.CodeInvalidArgument, "invalid_argument")
	}
	img, err := s.opts.Session.Capture(ctx, q.Cursor == nil || *q.Cursor)
	if err != nil {
		return nil, failure(connect.CodeUnavailable, "desktop_not_ready")
	}
	bounds := img.Bounds()
	if bounds.Dx() != int(screen.Width) || bounds.Dy() != int(screen.Height) {
		return nil, failure(connect.CodeUnavailable, "desktop_not_ready")
	}
	crop := bounds
	if q.Region != nil {
		v := q.Region
		crop = image.Rect(int(v.X), int(v.Y), int(v.X)+int(v.Width), int(v.Y)+int(v.Height))
		if v.Width == 0 || v.Height == 0 || !crop.In(bounds) {
			return nil, failure(connect.CodeInvalidArgument, "invalid_argument")
		}
	}
	ratio := 1.0
	if q.MaxWidth > 0 {
		ratio = min(ratio, float64(q.MaxWidth)/float64(crop.Dx()))
	}
	if q.MaxHeight > 0 {
		ratio = min(ratio, float64(q.MaxHeight)/float64(crop.Dy()))
	}
	width, height := max(1, int(float64(crop.Dx())*ratio)), max(1, int(float64(crop.Dy())*ratio))
	out := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(out, out.Bounds(), img, crop, draw.Src, nil)
	var b bytes.Buffer
	if format == "jpeg" {
		quality := int(q.Quality)
		if quality == 0 {
			quality = 80
		}
		err = jpeg.Encode(&b, out, &jpeg.Options{Quality: quality})
	} else {
		err = png.Encode(&b, out)
	}
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.DesktopScreenshotResponse{Data: b.Bytes(), ContentType: "image/" + format, Screen: screen, Image: &v1.DesktopSize{Width: uint32(width), Height: uint32(height)}, Cursor: cursor, Scale: float64(width) / float64(screen.Width)}), nil
}

// GetClipboard reads UTF-8 text from the session clipboard.
func (s *Service) GetClipboard(ctx context.Context, _ *connect.Request[v1.DesktopGetClipboardRequest]) (*connect.Response[v1.DesktopGetClipboardResponse], error) {
	if _, _, err := s.session(ctx); err != nil {
		return nil, err
	}
	text, has, err := s.opts.Session.ClipboardGet(ctx)
	if err != nil {
		return nil, failure(connect.CodeUnavailable, "clipboard_unavailable")
	}
	if len(text) > 1<<20 || !utf8.ValidString(text) {
		return nil, failure(connect.CodeResourceExhausted, "clipboard_unavailable")
	}
	return connect.NewResponse(&v1.DesktopGetClipboardResponse{Text: text, HasText: has}), nil
}

// SetClipboard sets session clipboard text after checking the size limit.
func (s *Service) SetClipboard(ctx context.Context, r *connect.Request[v1.DesktopSetClipboardRequest]) (*connect.Response[v1.DesktopSetClipboardResponse], error) {
	if _, _, err := s.session(ctx); err != nil {
		return nil, err
	}
	if len(r.Msg.Text) > 1<<20 || !utf8.ValidString(r.Msg.Text) {
		return nil, failure(connect.CodeInvalidArgument, "invalid_argument")
	}
	if err := s.opts.Session.ClipboardSet(ctx, r.Msg.Text); err != nil {
		return nil, failure(connect.CodeUnavailable, "clipboard_unavailable")
	}
	return connect.NewResponse(&v1.DesktopSetClipboardResponse{}), nil
}

// Act validates the entire batch before acquiring the input lease and executing it.
func (s *Service) Act(ctx context.Context, r *connect.Request[v1.DesktopActRequest]) (*connect.Response[v1.DesktopActResponse], error) {
	screen, _, err := s.session(ctx)
	if err != nil {
		return nil, err
	}
	actions, err := validateActions(r.Msg, screen)
	if err != nil {
		return nil, err
	}
	if r.Msg.Screenshot != nil {
		if err = validateScreenshot(r.Msg.Screenshot, screen); err != nil {
			return nil, err
		}
	}
	wait := time.NewTimer(10 * time.Second)
	defer wait.Stop()
	select {
	case s.input <- struct{}{}:
		defer func() { <-s.input }()
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-wait.C:
		return nil, failure(connect.CodeResourceExhausted, "desktop_busy")
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	result := &v1.DesktopActResponse{Screen: screen}
	for i, a := range actions {
		if a.Type == "wait" {
			timer := time.NewTimer(time.Duration(a.Ms) * time.Millisecond)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				err = ctx.Err()
			}
		} else {
			err = s.opts.Session.Input(ctx, a)
		}
		if err != nil {
			return nil, actionFailure(connect.CodeFailedPrecondition, "action_failed", i, result.Completed, "action failed")
		}
		result.Completed++
	}
	result.Screen, result.Cursor, err = s.opts.Session.State(ctx)
	if err != nil {
		return nil, failure(connect.CodeUnavailable, "desktop_not_ready")
	}
	if r.Msg.Screenshot != nil {
		shot, e := s.Screenshot(ctx, connect.NewRequest(r.Msg.Screenshot))
		if e != nil {
			return nil, e
		}
		result.Screenshot = shot.Msg
	}
	return connect.NewResponse(result), nil
}

// ActScrubber keeps screenshots out of the request cache (spec section 16):
// the stored Act outcome has no image. A repeat of the same Act does not
// repeat its input; when the request asked for a screenshot, the replay takes
// a fresh one (Screenshot has no side effects).
func (s *Service) ActScrubber() reqcache.Scrubber {
	return reqcache.Scrubber{
		Strip: func(res proto.Message) {
			if r, ok := res.(*v1.DesktopActResponse); ok {
				r.Screenshot = nil
			}
		},
		Refill: func(ctx context.Context, req, res proto.Message) error {
			in, ok := req.(*v1.DesktopActRequest)
			out, ok2 := res.(*v1.DesktopActResponse)
			if !ok || !ok2 || in.Screenshot == nil {
				return nil
			}
			shot, err := s.Screenshot(ctx, connect.NewRequest(in.Screenshot))
			if err != nil {
				return err
			}
			out.Screenshot = shot.Msg
			return nil
		},
	}
}
