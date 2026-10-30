package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// homeGuard keeps the agent's Filesystem API off the developer's home. The
// agent resolves "~", "~/..." and relative paths against the home of the
// OS user (os/user), which the harness cannot change without touching the
// agent: so every path of a Filesystem RPC and of /files* is rewritten on
// the internal listener before it reaches the agent. "~", "~/rest" and
// relative paths become scratch-absolute, and absolute paths in the real
// home move to the scratch directory too (as runner.go does for commands).
// A request the guard cannot read (compressed, a Connect GET) is refused.
type homeGuard struct {
	next    http.Handler
	home    string
	scratch string
}

// maxGuardedBody bounds a Filesystem RPC or a commit body (the agent's
// message limit).
const maxGuardedBody = 16 << 20

// mapPath returns p as the agent must see it. "" stays (the agent refuses it).
func (g homeGuard) mapPath(p string) string {
	switch {
	case p == "":
		return p
	case p == "~":
		return g.scratch
	case strings.HasPrefix(p, "~/"):
		return filepath.Join(g.scratch, p[2:])
	case !filepath.IsAbs(p):
		return filepath.Join(g.scratch, p)
	}
	clean := filepath.Clean(p)
	if clean == g.home {
		return g.scratch
	}
	if rest, ok := strings.CutPrefix(clean, g.home+"/"); ok {
		return filepath.Join(g.scratch, rest)
	}
	return p
}

// filesystemRequests are the request messages of sbx.agent.v1.Filesystem.
var filesystemRequests = map[string]func() proto.Message{
	"Stat":    func() proto.Message { return &agentv1.StatRequest{} },
	"List":    func() proto.Message { return &agentv1.FilesystemListRequest{} },
	"MakeDir": func() proto.Message { return &agentv1.MakeDirRequest{} },
	"Move":    func() proto.Message { return &agentv1.MoveRequest{} },
	"Chmod":   func() proto.Message { return &agentv1.ChmodRequest{} },
	"Remove":  func() proto.Message { return &agentv1.FilesystemRemoveRequest{} },
}

func (g homeGuard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// /v1/machines/<id>/<rest>
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/v1/machines/"), "/", 2)
	if len(parts) != 2 || !strings.HasPrefix(r.URL.Path, "/v1/machines/") {
		g.next.ServeHTTP(w, r)
		return
	}
	rest := "/" + parts[1]
	var err error
	switch {
	case strings.HasPrefix(rest, "/rpc/sbx.agent.v1.Filesystem/"):
		err = g.rewriteRPC(r, strings.TrimPrefix(rest, "/rpc/sbx.agent.v1.Filesystem/"))
	case rest == "/files" || strings.HasPrefix(rest, "/files/"):
		err = g.rewriteFiles(r, rest)
	}
	if err != nil {
		http.Error(w, "sbx-agent-harness: "+err.Error(), http.StatusBadRequest)
		return
	}
	g.next.ServeHTTP(w, r)
}

// rewriteRPC maps path, src and dst of a unary Filesystem request.
func (g homeGuard) rewriteRPC(r *http.Request, method string) error {
	newMsg, ok := filesystemRequests[method]
	if !ok {
		return nil
	}
	if r.Method != http.MethodPost {
		return fmt.Errorf("filesystem %s over %s is not supported", method, r.Method)
	}
	body, err := readBody(r)
	if err != nil {
		return err
	}
	msg := newMsg()
	ct := r.Header.Get("Content-Type")
	isJSON := strings.HasPrefix(ct, "application/json")
	if isJSON {
		err = protojson.Unmarshal(body, msg)
	} else {
		err = proto.Unmarshal(body, msg)
	}
	if err != nil {
		return fmt.Errorf("filesystem %s: %w", method, err)
	}
	fields := msg.ProtoReflect().Descriptor().Fields()
	for _, name := range []string{"path", "src", "dst"} {
		if f := fields.ByName(protoreflect.Name(name)); f != nil {
			v := msg.ProtoReflect().Get(f).String()
			msg.ProtoReflect().Set(f, protoreflect.ValueOfString(g.mapPath(v)))
		}
	}
	if isJSON {
		body, err = protojson.Marshal(msg)
	} else {
		body, err = proto.Marshal(msg)
	}
	if err != nil {
		return err
	}
	setBody(r, body)
	return nil
}

// rewriteFiles maps the path query of /files* and the path of a commit body.
func (g homeGuard) rewriteFiles(r *http.Request, rest string) error {
	q := r.URL.Query()
	if q.Has("path") {
		q.Set("path", g.mapPath(q.Get("path")))
		r.URL.RawQuery = q.Encode()
		r.RequestURI = ""
	}
	if r.Method != http.MethodPost || !strings.HasPrefix(rest, "/files/uploads/") || !strings.HasSuffix(rest, "/commit") {
		return nil
	}
	body, err := readBody(r)
	if err != nil {
		return err
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		// Not JSON: the agent answers it.
		setBody(r, body)
		return nil //nolint:nilerr // passed on unchanged
	}
	if p, ok := m["path"].(string); ok {
		m["path"] = g.mapPath(p)
	}
	if body, err = json.Marshal(m); err != nil {
		return err
	}
	setBody(r, body)
	return nil
}

func readBody(r *http.Request) ([]byte, error) {
	if ce := r.Header.Get("Content-Encoding"); ce != "" && ce != "identity" {
		return nil, fmt.Errorf("a %s body cannot be checked", ce)
	}
	if r.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, maxGuardedBody+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxGuardedBody {
		return nil, fmt.Errorf("body above %d bytes", maxGuardedBody)
	}
	return b, nil
}

func setBody(r *http.Request, b []byte) {
	r.Body = io.NopCloser(bytes.NewReader(b))
	r.ContentLength = int64(len(b))
	r.Header.Set("Content-Length", strconv.Itoa(len(b)))
}
