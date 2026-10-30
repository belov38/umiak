package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"runtime"
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

// mapPath returns p as the agent must see it. "" stays (the agent refuses
// it). "~", "~/rest" and relative paths are joined onto the scratch dir and
// must stay in it (a "..", enough of them, would leave it); every absolute
// result in the real home moves to the scratch dir.
func (g homeGuard) mapPath(p string) (string, error) {
	switch {
	case p == "":
		return p, nil
	case p == "~":
		return g.scratch, nil
	case strings.HasPrefix(p, "~/"):
		p = filepath.Join(g.scratch, p[2:])
	case !filepath.IsAbs(p):
		p = filepath.Join(g.scratch, p)
	default:
		return g.fromHome(p), nil
	}
	if _, ok := under(p, g.scratch); !ok {
		return "", fmt.Errorf("path %q leaves the scratch directory", p)
	}
	return g.fromHome(p), nil
}

// fromHome moves an absolute path in the real home to the scratch dir.
func (g homeGuard) fromHome(p string) string {
	clean := filepath.Clean(p)
	if rest, ok := under(clean, g.home); ok {
		return filepath.Join(g.scratch, rest)
	}
	return p
}

// under reports whether the clean path p is dir or inside it, and the rest
// below dir. darwin file systems are case-insensitive by default.
func under(p, dir string) (string, bool) {
	eq := func(a, b string) bool { return a == b }
	if runtime.GOOS == "darwin" {
		eq = strings.EqualFold
	}
	if eq(p, dir) {
		return "", true
	}
	if len(p) > len(dir) && p[len(dir)] == '/' && eq(p[:len(dir)], dir) {
		return p[len(dir)+1:], true
	}
	return "", false
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
			v, err := g.mapPath(msg.ProtoReflect().Get(f).String())
			if err != nil {
				return err
			}
			msg.ProtoReflect().Set(f, protoreflect.ValueOfString(v))
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
		v, err := g.mapPath(q.Get("path"))
		if err != nil {
			return err
		}
		q.Set("path", v)
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
	if body, err = g.rewriteCommit(body); err != nil {
		return err
	}
	setBody(r, body)
	return nil
}

// rewriteCommit maps the path of a commit body. A body it cannot read
// strictly is refused, never passed on: one JSON object, nothing after it,
// and at most one key that is "path" in any case (the agent's json.Decoder
// matches field names case-insensitively), spelled exactly "path".
func (g homeGuard) rewriteCommit(body []byte) ([]byte, error) {
	bad := func(why string) ([]byte, error) {
		return nil, fmt.Errorf("commit body: %s", why)
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return bad("not a JSON object")
	}
	m := map[string]any{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return bad(err.Error())
		}
		key, _ := t.(string)
		if strings.EqualFold(key, "path") {
			if key != "path" {
				return bad(fmt.Sprintf("key %q", key))
			}
			if _, dup := m[key]; dup {
				return bad("path given twice")
			}
		}
		var v any
		if err := dec.Decode(&v); err != nil {
			return bad(err.Error())
		}
		m[key] = v
	}
	if _, err := dec.Token(); err != nil {
		return bad(err.Error())
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return bad("data after the object")
	}
	if v, ok := m["path"]; ok {
		p, ok := v.(string)
		if !ok {
			return bad("path is not a string")
		}
		mapped, err := g.mapPath(p)
		if err != nil {
			return nil, err
		}
		m["path"] = mapped
	}
	return json.Marshal(m)
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
