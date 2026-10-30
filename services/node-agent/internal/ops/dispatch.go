// Package ops implements the sbx-node operation whitelist.
package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/node-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/node-agent/internal/lvm"
)

// Request is one JSON request read from stdin.
type Request struct {
	Op        string          `json:"op"`
	Args      json.RawMessage `json:"args"`
	RequestID string          `json:"requestId"`
}

// Error is the error half of a Response.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Response is written to stdout.
type Response struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  *Error `json:"error,omitempty"`
}

// Host gives read access to the node filesystem (rooted at "/"), runs commands and
// rewrites files under a lock.
type Host struct {
	FS      fs.FS
	Run     lvm.Runner
	Now     func() time.Time
	Replace func(path string, edit func([]byte) ([]byte, error)) error
	// Sleep defaults to time.Sleep.
	Sleep func(time.Duration)
}

// Server executes whitelisted operations.
type Server struct {
	Cfg     config.Config
	LVM     lvm.LVM
	Host    Host
	Log     func(string)
	Version string
	// ScanOpen opens LV devices for lv.scan; nil reads /dev/<vg>/<lv>.
	ScanOpen ScanOpener
	// OnHash is called each time media.sha256 reads a file instead of using its cache; tests count it.
	OnHash func(name string)
}

type badRequest struct{ msg string }

func (e badRequest) Error() string { return e.msg }

func badReq(format string, args ...any) error { return badRequest{fmt.Sprintf(format, args...)} }

type handler func(s *Server, ctx context.Context, args json.RawMessage) (any, error)

var handlers = map[string]handler{
	"version":      (*Server).version,
	"lv.snapshot":  (*Server).lvSnapshot,
	"lv.remove":    (*Server).lvRemove,
	"lv.list":      (*Server).lvList,
	"pool.usage":   (*Server).poolUsage,
	"dhcp.leases":  (*Server).dhcpLeases,
	"dhcp.release": (*Server).dhcpRelease,
	"inventory":    (*Server).inventory,
	"media.list":   (*Server).mediaList,
	"media.remove": (*Server).mediaRemove,
	"media.sha256": (*Server).mediaSHA256,
	"lv.scan":      (*Server).lvScan,
	"lv.usage":     (*Server).lvUsage,
}

// decodeArgs decodes optional args strictly.
func decodeArgs(raw json.RawMessage, v any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return badReq("args: %v", err)
	}
	return nil
}

// Handle parses one request, runs it and logs the outcome.
func (s *Server) Handle(ctx context.Context, raw []byte) Response {
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		s.Log(fmt.Sprintf("bad request: %v", err))
		return Response{Error: &Error{Code: "bad_request", Message: err.Error()}}
	}
	h, ok := handlers[req.Op]
	var (
		result any
		err    error
	)
	if !ok {
		err = badReq("unknown op %q", req.Op)
	} else {
		result, err = h(s, ctx, req.Args)
	}
	args := redactArgs(req.Op, req.Args)
	if err != nil {
		code := errorCode(err)
		s.Log(fmt.Sprintf("requestId=%q op=%q args=%s result=error code=%s msg=%q", req.RequestID, req.Op, args, code, err.Error()))
		return Response{Error: &Error{Code: code, Message: err.Error()}}
	}
	s.Log(fmt.Sprintf("requestId=%q op=%q args=%s result=ok", req.RequestID, req.Op, args))
	return Response{OK: true, Result: result}
}

func errorCode(err error) string {
	var br badRequest
	switch {
	case errors.As(err, &br):
		return "bad_request"
	case errors.Is(err, ErrForbidden), errors.Is(err, errBadName):
		return "forbidden"
	case errors.Is(err, fs.ErrNotExist):
		return "not_found"
	case errors.Is(err, ErrBusy):
		return "busy"
	default:
		return "exec_failed"
	}
}

// redactArgs drops the inventory search string: it may be a bootstrap secret carrier.
func redactArgs(op string, raw json.RawMessage) string {
	if len(raw) == 0 {
		return "{}"
	}
	secret := map[string]string{"inventory": "search", "lv.scan": "patterns"}[op]
	if secret == "" {
		return string(raw)
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return "<unparsed>"
	}
	// encoding/json matches field names case-insensitively, so redact any spelling of the key.
	for k := range m {
		if strings.EqualFold(k, secret) {
			m[k] = "<redacted>"
		}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func (s *Server) version(context.Context, json.RawMessage) (any, error) {
	kernel, _ := fs.ReadFile(s.Host.FS, "proc/sys/kernel/osrelease")
	return map[string]any{"version": s.Version, "config": s.Cfg, "kernel": strings.TrimSpace(string(kernel))}, nil
}
