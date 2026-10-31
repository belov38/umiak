package desktop

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// StreamHost isolates systemd/SCM and private files from the pinned HTTP protocol.
type StreamHost interface {
	Prepare(context.Context, Credentials, []*v1.DesktopIceServer) (bool, error)
	Start(context.Context) error
	Stop(context.Context) error
	RestartWeb(context.Context) error
	Viewers(context.Context) (uint32, error)
}

// HTTPStreamer implements Sunshine v2026.914.233613 + moonlight-web v3.0.1.
type HTTPStreamer struct {
	host          StreamHost
	client        *http.Client
	sun, moon     string
	mu            sync.Mutex
	creds         Credentials
	hostID, appID string
	active        atomic.Bool
}

// NewHTTPStreamer constructs the pinned HTTP protocol adapter.
func NewHTTPStreamer(host StreamHost, client *http.Client, sun, moon string) *HTTPStreamer {
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	copyClient.Timeout = 35 * time.Second
	copyClient.Jar, _ = cookiejar.New(nil)
	return &HTTPStreamer{host: host, client: &copyClient, sun: sun, moon: moon}
}
func (s *HTTPStreamer) request(ctx context.Context, method, base, path string, body any) (*http.Response, error) {
	var input io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return nil, e
		}
		input = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, base+path, input)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Content-Type", "application/json")
	if base == s.sun && (strings.HasPrefix(path, "/api/pin") || path == "/api/password" || path == "/api/apps/close") {
		req.SetBasicAuth(s.creds.Username, s.creds.Password)
	}
	res, e := s.client.Do(req)
	if e != nil {
		return nil, e
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		_ = res.Body.Close()
		return nil, fmt.Errorf("streamer: %s status %d", path, res.StatusCode)
	}
	return res, nil
}
func (s *HTTPStreamer) json(ctx context.Context, method, base, path string, body, out any) error {
	res, e := s.request(ctx, method, base, path, body)
	if e != nil {
		return e
	}
	defer func() { _ = res.Body.Close() }()
	if out == nil {
		_, e = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		return e
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out)
}

// Open starts and pairs the pinned upstream streaming stack.
func (s *HTTPStreamer) Open(ctx context.Context, c Credentials, ice []*v1.DesktopIceServer) (string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	reset, e := s.host.Prepare(ctx, c, ice)
	if e != nil {
		return "", "", e
	}
	if reset {
		s.hostID = ""
		s.appID = ""
		s.active.Store(false)
	}
	if e = s.host.Start(ctx); e != nil {
		return "", "", e
	}
	s.creds = c
	if s.active.Load() && s.hostID != "" {
		return s.hostID, s.appID, nil
	}
	// The same request also recovers an interrupted first bootstrap. No credential CLI args.
	for {
		var status struct {
			Status bool `json:"status"`
		}
		e = s.json(ctx, "POST", s.sun, "/api/password", map[string]string{"currentUsername": c.Username, "currentPassword": c.Password, "newUsername": c.Username, "newPassword": c.Password, "confirmNewPassword": c.Password}, &status)
		if e == nil {
			if !status.Status {
				return "", "", errors.New("sunshine rejected credential setup")
			}
			break
		}
		if e = pause(ctx, 200*time.Millisecond); e != nil {
			return "", "", e
		}
	}
	for {
		e = s.json(ctx, "POST", s.moon, "/api/login", map[string]string{"name": c.Username, "password": c.Password}, nil)
		if e == nil {
			break
		}
		if e = pause(ctx, 200*time.Millisecond); e != nil {
			return "", "", e
		}
	}
	// Pre-create the fixed reverse-proxy user with the ordinary User role.
	var user json.RawMessage
	if e = s.json(ctx, "GET", s.moon, "/api/user?name=sbx", nil, &user); e != nil {
		var role struct {
			ID uint32 `json:"id"`
		}
		if e = s.json(ctx, "GET", s.moon, "/api/role/default", nil, &role); e != nil {
			return "", "", e
		}
		permissions := map[string]any{"allow_add_hosts": false, "maximum_bitrate_kbps": nil, "allow_codec_h264": true, "allow_codec_h265": true, "allow_codec_av1": true, "allow_hdr": false, "allow_transport_webrtc": true, "allow_transport_websockets": true}
		if e = s.json(ctx, "PATCH", s.moon, "/api/role", map[string]any{"id": role.ID, "ty": "User", "permissions": permissions}, nil); e != nil {
			return "", "", e
		}
		if e = s.json(ctx, "POST", s.moon, "/api/user", map[string]any{"name": "sbx", "password": c.Password, "role_id": role.ID, "client_unique_id": "sbx-desktop"}, &user); e != nil {
			return "", "", e
		}
	}
	// Discover existing global host after an agent/process restart, avoiding duplicate pairing.
	var hosts struct {
		Hosts []moonHost `json:"hosts"`
	}
	res, e := s.request(ctx, "GET", s.moon, "/api/hosts", nil)
	if e == nil {
		e = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&hosts)
		_ = res.Body.Close()
	}
	var host moonHost
	if e == nil {
		for _, h := range hosts.Hosts {
			if h.Address == "127.0.0.1" {
				host = h
				break
			}
		}
	}
	if host.ID == 0 {
		var out struct {
			Host moonHost `json:"host"`
		}
		if e = s.json(ctx, "POST", s.moon, "/api/host", map[string]any{"address": "127.0.0.1", "http_port": 47989}, &out); e != nil {
			return "", "", e
		}
		host = out.Host
	}
	if host.ID == 0 {
		return "", "", errors.New("moonlight returned no host")
	}
	if e = s.json(ctx, "PATCH", s.moon, "/api/host", map[string]any{"host_id": host.ID, "change_owner": true, "owner": nil}, nil); e != nil {
		return "", "", e
	}
	if host.Paired != "Paired" {
		if e = s.pair(ctx, host.ID); e != nil {
			return "", "", e
		}
	}
	var apps struct {
		Apps []struct {
			ID    uint32 `json:"app_id"`
			Title string `json:"title"`
		} `json:"apps"`
	}
	if e = s.json(ctx, "GET", s.moon, "/api/apps?host_id="+strconv.FormatUint(uint64(host.ID), 10), nil, &apps); e != nil {
		return "", "", e
	}
	for _, app := range apps.Apps {
		if app.Title == "Desktop" {
			s.hostID = strconv.FormatUint(uint64(host.ID), 10)
			s.appID = strconv.FormatUint(uint64(app.ID), 10)
		}
	}
	if s.appID == "" {
		return "", "", errors.New("desktop app missing")
	}
	s.active.Store(true)
	return s.hostID, s.appID, nil
}

type moonHost struct {
	ID      uint32 `json:"host_id"`
	Paired  string `json:"paired"`
	Address string `json:"address"`
}

func (s *HTTPStreamer) pair(ctx context.Context, id uint32) error {
	res, e := s.request(ctx, "POST", s.moon, "/api/pair", map[string]uint32{"host_id": id})
	if e != nil {
		return e
	}
	defer func() { _ = res.Body.Close() }()
	scan := bufio.NewScanner(io.LimitReader(res.Body, 1<<20))
	scan.Buffer(make([]byte, 4096), 1<<20)
	if !scan.Scan() {
		return errors.New("missing moonlight pairing PIN")
	}
	var first struct {
		PIN string `json:"Pin"`
	}
	if e = json.Unmarshal(scan.Bytes(), &first); e != nil || len(first.PIN) != 4 {
		return errors.New("invalid moonlight PIN")
	}
	var pending struct {
		Pairings []struct {
			ID      string `json:"id"`
			Address string `json:"address"`
		} `json:"pairings"`
	}
	for {
		if e = s.json(ctx, "GET", s.sun, "/api/pin", nil, &pending); e != nil {
			return e
		}
		if len(pending.Pairings) == 1 {
			break
		}
		if len(pending.Pairings) > 1 {
			return errors.New("ambiguous Sunshine pairing requests")
		}
		if e = pause(ctx, 100*time.Millisecond); e != nil {
			return e
		}
	}
	p := pending.Pairings[0]
	if p.Address != "127.0.0.1" && p.Address != "::1" {
		return errors.New("unexpected pairing peer")
	}
	var status struct {
		Status bool `json:"status"`
	}
	if e = s.json(ctx, "POST", s.sun, "/api/pin", map[string]string{"pairing_id": p.ID, "pin": first.PIN, "name": "sbx-desktop"}, &status); e != nil {
		return e
	}
	if !status.Status {
		return errors.New("sunshine pairing failed")
	}
	if !scan.Scan() {
		return errors.New("moonlight pairing did not finish")
	}
	var last struct {
		Paired *moonHost `json:"Paired"`
	}
	if e = json.Unmarshal(scan.Bytes(), &last); e != nil || last.Paired == nil || last.Paired.ID != id || last.Paired.Paired != "Paired" {
		return errors.New("moonlight pairing failed")
	}
	return nil
}

// Stop stops both streaming services.
func (s *HTTPStreamer) Stop(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.host.Stop(ctx)
	if e == nil {
		s.active.Store(false)
	}
	return e
}

// EndStreams implements the desktop adapter boundary.
func (s *HTTPStreamer) EndStreams(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active.Load() {
		return s.host.Stop(ctx)
	}
	var status struct {
		Status bool `json:"status"`
	}
	if e := s.json(ctx, "POST", s.sun, "/api/apps/close", struct{}{}, &status); e != nil {
		return e
	}
	if !status.Status {
		return errors.New("sunshine did not close streams")
	}
	return s.host.RestartWeb(ctx)
}

// Viewers samples observed active media clients.
func (s *HTTPStreamer) Viewers(ctx context.Context) (uint32, error) {
	return s.host.Viewers(ctx)
}
func viewerLogCount(log string) uint32 {
	var count uint32
	for _, line := range strings.Split(log, "\n") {
		if strings.Contains(line, "Sunshine version:") {
			count = 0
		}
		if strings.HasSuffix(strings.TrimSpace(line), "CLIENT CONNECTED") {
			count++
		}
		if strings.HasSuffix(strings.TrimSpace(line), "CLIENT DISCONNECTED") && count > 0 {
			count--
		}
	}
	return count
}
func conntrackViewers(text string) uint32 {
	var n uint32
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || !strings.Contains(line, "[ASSURED]") || !strings.Contains(line, "dport=47999 ") {
			continue
		}
		if fields[0] == "udp" || strings.Contains(line, " udp ") {
			n++
		}
	}
	return n
}
