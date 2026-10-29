// Package docker is a minimal Docker Engine API client over the daemon's
// unix socket: ping, list running and paused containers, pause and unpause
// (spec sections 8.5 and 14.2). Paths are unversioned, so the daemon answers
// with its own API version.
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// DefaultSocket is the Docker daemon socket.
const DefaultSocket = "/var/run/docker.sock"

// maxBody bounds a response body read by the client.
const maxBody = 8 << 20

// ErrNoDaemon is returned when the daemon socket is missing or refuses
// connections: Docker is not installed or not running.
var ErrNoDaemon = errors.New("docker: daemon not reachable")

// APIError is a non-2xx answer of the daemon.
type APIError struct {
	// Status is the HTTP status code.
	Status int
	// Message is the daemon's error message.
	Message string
}

// Error implements error.
func (e *APIError) Error() string {
	return fmt.Sprintf("docker: %d: %s", e.Status, e.Message)
}

// IsNotFound reports whether err is a 404 of the daemon (no such container).
func IsNotFound(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Status == http.StatusNotFound
}

// IsNotPaused reports whether err is the daemon's 409 answer to an unpause
// of a container that is not paused.
func IsNotPaused(err error) bool {
	var e *APIError
	return errors.As(err, &e) && e.Status == http.StatusConflict
}

// Client talks to the Docker daemon. The zero value uses DefaultSocket.
type Client struct {
	// Socket is the daemon socket path. Default DefaultSocket.
	Socket string
	// HTTP overrides the HTTP client; by default a client dialing Socket
	// is built on first use.
	HTTP *http.Client

	once sync.Once
	hc   *http.Client
}

// client returns the HTTP client of c.
func (c *Client) client() *http.Client {
	c.once.Do(func() {
		if c.HTTP != nil {
			c.hc = c.HTTP
			return
		}
		sock := c.Socket
		if sock == "" {
			sock = DefaultSocket
		}
		var d net.Dialer
		c.hc = &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				conn, err := d.DialContext(ctx, "unix", sock)
				if err != nil {
					return nil, fmt.Errorf("%w: %w", ErrNoDaemon, err)
				}
				return conn, nil
			},
			MaxIdleConns:    4,
			IdleConnTimeout: 30 * time.Second,
		}}
	})
	return c.hc
}

// Ping checks that the daemon answers GET /_ping.
func (c *Client) Ping(ctx context.Context) error {
	return c.do(ctx, http.MethodGet, "/_ping", nil, nil)
}

// container is the part of a GET /containers/json entry the client reads.
type container struct {
	ID    string `json:"Id"`
	State string `json:"State"`
}

// Running returns the ids of the containers in state running (paused and
// restarting containers are not included).
func (c *Client) Running(ctx context.Context) ([]string, error) {
	return c.list(ctx, nil, "running")
}

// Paused returns the ids of the paused containers.
func (c *Client) Paused(ctx context.Context) ([]string, error) {
	q := url.Values{"filters": {`{"status":["paused"]}`}}
	return c.list(ctx, q, "paused")
}

// list lists containers with the query q and keeps those in state.
func (c *Client) list(ctx context.Context, q url.Values, state string) ([]string, error) {
	var all []container
	if err := c.do(ctx, http.MethodGet, "/containers/json", q, &all); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(all))
	for _, ct := range all {
		if ct.State == state && ct.ID != "" {
			ids = append(ids, ct.ID)
		}
	}
	return ids, nil
}

// Pause pauses container id (POST /containers/{id}/pause).
func (c *Client) Pause(ctx context.Context, id string) error {
	return c.containerOp(ctx, id, "pause")
}

// Unpause unpauses container id (POST /containers/{id}/unpause). A
// container that is not paused yields an error for which IsNotPaused is
// true.
func (c *Client) Unpause(ctx context.Context, id string) error {
	return c.containerOp(ctx, id, "unpause")
}

// containerOp posts /containers/{id}/{op}.
func (c *Client) containerOp(ctx context.Context, id, op string) error {
	if id == "" {
		return errors.New("docker: empty container id")
	}
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/"+op, nil, nil)
}

// do sends one request and decodes a JSON answer into out (when non-nil).
// The escaped path is sent as is, so a container id stays one segment.
func (c *Client) do(ctx context.Context, method, escapedPath string, q url.Values, out any) error {
	u := &url.URL{Scheme: "http", Host: "docker", RawQuery: q.Encode()}
	p, err := url.PathUnescape(escapedPath)
	if err != nil {
		return fmt.Errorf("docker: bad path %q: %w", escapedPath, err)
	}
	u.Path, u.RawPath = p, escapedPath
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return fmt.Errorf("docker: %s %s: %w", method, escapedPath, err)
	}
	resp, err := c.client().Do(req)
	if err != nil {
		return fmt.Errorf("docker: %s %s: %w", method, escapedPath, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return fmt.Errorf("docker: %s %s: read body: %w", method, escapedPath, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &APIError{Status: resp.StatusCode, Message: errorMessage(body)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("docker: %s %s: decode: %w", method, escapedPath, err)
	}
	return nil
}

// errorMessage extracts the daemon's {"message": ...} or falls back to the
// trimmed body.
func errorMessage(body []byte) string {
	var m struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &m) == nil && m.Message != "" {
		return m.Message
	}
	s := strings.TrimSpace(string(body))
	if len(s) > 512 {
		s = s[:512]
	}
	return s
}
