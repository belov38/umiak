package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"time"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// RemoteSession talks only to the private socket owned by the interactive user.
type RemoteSession struct {
	Client *http.Client
	URL    string
}
type sessionState struct {
	Screen *v1.DesktopSize
	Cursor *v1.DesktopPoint
}
type clipboardText struct {
	Text    string
	HasText bool
}

// SocketSession never uses DNS, proxies or a TCP fallback.
func SocketSession(path string) *RemoteSession {
	t := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", path)
	}}
	return &RemoteSession{Client: &http.Client{Transport: t, Timeout: 65 * time.Second}, URL: "http://session"}
}
func (s *RemoteSession) call(ctx context.Context, method, path string, body, out any) error {
	var input io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		input = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, s.URL+path, input)
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	res, e := s.Client.Do(req)
	if e != nil {
		return e
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("session: %s status %d", path, res.StatusCode)
	}
	if shot, ok := out.(*image.Image); ok {
		*shot, e = png.Decode(io.LimitReader(res.Body, 32<<20))
		return e
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(out)
}

// State returns the live screen dimensions and pointer.
func (s *RemoteSession) State(ctx context.Context) (*v1.DesktopSize, *v1.DesktopPoint, error) {
	var out sessionState
	e := s.call(ctx, "GET", "/state", nil, &out)
	return out.Screen, out.Cursor, e
}

// Capture captures the desktop independently of video streaming.
func (s *RemoteSession) Capture(ctx context.Context, cursor bool) (image.Image, error) {
	var img image.Image
	e := s.call(ctx, "POST", "/capture", map[string]bool{"cursor": cursor}, &img)
	return img, e
}

// Input dispatches a validated input action.
func (s *RemoteSession) Input(ctx context.Context, a *v1.DesktopAction) error {
	var out struct{}
	return s.call(ctx, "POST", "/input", a, &out)
}

// ClipboardGet reads the interactive text selection.
func (s *RemoteSession) ClipboardGet(ctx context.Context) (string, bool, error) {
	var out clipboardText
	e := s.call(ctx, "GET", "/clipboard", nil, &out)
	return out.Text, out.HasText, e
}

// ClipboardSet owns the interactive text selection.
func (s *RemoteSession) ClipboardSet(ctx context.Context, text string) error {
	var out struct{}
	return s.call(ctx, "PUT", "/clipboard", clipboardText{Text: text}, &out)
}

// SessionHandler is served on a mode-0600 AF_UNIX socket, never a guest TCP port.
func SessionHandler(s Session) http.Handler {
	m := http.NewServeMux()
	handle := func(pattern string, f func(http.ResponseWriter, *http.Request) (any, error)) {
		m.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
			out, e := f(w, r)
			if e != nil {
				http.Error(w, "session unavailable", http.StatusServiceUnavailable)
				return
			}
			if out != nil {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(out)
			}
		})
	}
	handle("GET /state", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		screen, cursor, e := s.State(r.Context())
		return sessionState{screen, cursor}, e
	})
	handle("POST /capture", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var q struct{ Cursor bool }
		if e := json.NewDecoder(r.Body).Decode(&q); e != nil {
			return nil, e
		}
		img, e := s.Capture(r.Context(), q.Cursor)
		if e != nil {
			return nil, e
		}
		w.Header().Set("Content-Type", "image/png")
		return nil, png.Encode(w, img)
	})
	handle("POST /input", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		var a v1.DesktopAction
		if e := json.NewDecoder(r.Body).Decode(&a); e != nil {
			return nil, e
		}
		screen, _, e := s.State(r.Context())
		if e != nil {
			return nil, e
		}
		as, e := validateActions(&v1.DesktopActRequest{Actions: []*v1.DesktopAction{&a}}, screen)
		if e != nil {
			return nil, e
		}
		return struct{}{}, s.Input(r.Context(), as[0])
	})
	handle("GET /clipboard", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		text, has, e := s.ClipboardGet(r.Context())
		return clipboardText{text, has}, e
	})
	handle("PUT /clipboard", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		var q clipboardText
		if e := json.NewDecoder(r.Body).Decode(&q); e != nil {
			return nil, e
		}
		if len(q.Text) > 1<<20 {
			return nil, errors.New("clipboard too large")
		}
		return struct{}{}, s.ClipboardSet(r.Context(), q.Text)
	})
	return m
}
