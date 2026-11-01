package harness_test

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/tunnel/rpcconv"
	"github.com/belov38/umiak/libs/tunnel/wire"
)

func TestHarnessMutationRequiresRequestID(t *testing.T) {
	e := newEnv(t)
	dir := filepath.Join(e.root, "made", "here")
	req := &agentv1.MakeDirRequest{Path: dir, Parents: true}

	_, err := e.filesystem().MakeDir(ctx(t), connect.NewRequest(req))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("MakeDir without Umiak-Request-Id = %v, want invalid_argument", err)
	}
	if d, ok := rpcconv.Detail(err); !ok || d.GetCode() != wire.CodeRequestIDRequired {
		t.Fatalf("detail %v, want %s", d, wire.CodeRequestIDRequired)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the refused call created the directory: %v", err)
	}

	id := uuid.NewString()
	first, err := e.filesystem().MakeDir(ctx(t), withRequestID(connect.NewRequest(req), id))
	if err != nil {
		t.Fatalf("MakeDir: %v", err)
	}
	if !first.Msg.GetCreated() {
		t.Fatalf("MakeDir = %v, want created", first.Msg)
	}
	// The replay returns the cached response: created stays true although
	// the directory exists now.
	again, err := e.filesystem().MakeDir(ctx(t), withRequestID(connect.NewRequest(req), id))
	if err != nil {
		t.Fatalf("replayed MakeDir: %v", err)
	}
	if !proto.Equal(first.Msg, again.Msg) {
		t.Fatalf("replay = %v, want %v", again.Msg, first.Msg)
	}
	// A new request id runs the call again.
	fresh, err := e.filesystem().MakeDir(ctx(t), withRequestID(connect.NewRequest(req), uuid.NewString()))
	if err != nil || fresh.Msg.GetCreated() {
		t.Fatalf("MakeDir with a new id = %v, %v; want created=false", fresh.Msg, err)
	}
}

// query encodes key/value pairs.
func query(kv ...string) string {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	return "?" + v.Encode()
}

func TestHarnessUploadOffsetHeaderPasses(t *testing.T) {
	e := newEnv(t)
	dst := filepath.Join(e.root, "upload.bin")
	part1, part2 := bytes.Repeat([]byte("x"), 1000), []byte("tail")
	id := "upl_harness_1"

	res := e.do(http.MethodPut, "/uploads/"+id+query("offset", "0", "path", dst), bytes.NewReader(part1))
	if res.status != http.StatusOK || res.header.Get(wire.HeaderUploadOffset) != "1000" {
		t.Fatalf("first chunk: %d %q %s", res.status, res.header.Get(wire.HeaderUploadOffset), res.body)
	}

	// A chunk at the wrong offset: 409 and the current offset, through the
	// gateway.
	res = e.do(http.MethodPut, "/uploads/"+id+query("offset", "7"), bytes.NewReader(part2))
	if res.status != http.StatusConflict {
		t.Fatalf("wrong offset: %d %s, want 409", res.status, res.body)
	}
	got := res.header.Get(wire.HeaderUploadOffset)
	if got != "1000" {
		t.Fatalf("Umiak-Upload-Offset = %q, want 1000", got)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(res.body, &body); err != nil || body.Code != "upload_offset_mismatch" {
		t.Fatalf("409 body %s (%v)", res.body, err)
	}

	res = e.do(http.MethodPut, "/uploads/"+id+query("offset", got), bytes.NewReader(part2))
	if res.status != http.StatusOK || res.header.Get(wire.HeaderUploadOffset) != strconv.Itoa(len(part1)+len(part2)) {
		t.Fatalf("resumed chunk: %d %q %s", res.status, res.header.Get(wire.HeaderUploadOffset), res.body)
	}
	commit, _ := json.Marshal(map[string]any{"path": dst})
	res = e.do(http.MethodPost, "/uploads/"+id+"/commit", bytes.NewReader(commit))
	if res.status != http.StatusOK {
		t.Fatalf("commit: %d %s", res.status, res.body)
	}
	want := slices.Concat(part1, part2)
	content, err := os.ReadFile(dst)
	if err != nil || !bytes.Equal(content, want) {
		t.Fatalf("uploaded file: %d bytes, %v", len(content), err)
	}
	// Download it back through the gateway (do checks Content-Encoding on
	// every response above too).
	res = e.do(http.MethodGet, query("path", dst), nil)
	if res.status != http.StatusOK || !bytes.Equal(res.body, want) {
		t.Fatalf("download: %d, %d bytes", res.status, len(res.body))
	}
}

func TestHarnessArchiveThroughGateway(t *testing.T) {
	e := newEnv(t)
	src := filepath.Join(e.root, "src")
	files := map[string][]byte{
		"a.txt":         []byte("alpha"),
		"sub/b.txt":     []byte("bravo"),
		"sub/deep/c.sh": bytes.Repeat([]byte("c"), 200<<10),
	}
	for name, data := range files {
		p := filepath.Join(src, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	res := e.do(http.MethodGet, "/archive"+query("path", src, "format", "tar"), nil)
	if res.status != http.StatusOK || res.header.Get("Content-Type") != "application/x-tar" {
		t.Fatalf("GET archive: %d %v %s", res.status, res.header, res.body)
	}
	got := map[string][]byte{}
	tr := tar.NewReader(bytes.NewReader(res.body))
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Typeflag == tar.TypeReg {
			b, _ := io.ReadAll(tr)
			got[hdr.Name] = b
		}
	}
	for name, data := range files {
		if !bytes.Equal(got[name], data) {
			t.Errorf("archive entry %s: %d bytes, want %d", name, len(got[name]), len(data))
		}
	}

	dst := filepath.Join(e.root, "dst")
	res = e.do(http.MethodPut, "/archive"+query("path", dst, "format", "tar"), bytes.NewReader(res.body))
	if res.status != http.StatusOK {
		t.Fatalf("PUT archive: %d %s", res.status, res.body)
	}
	for name, data := range files {
		b, err := os.ReadFile(filepath.Join(dst, filepath.FromSlash(name)))
		if err != nil || !bytes.Equal(b, data) {
			t.Errorf("extracted %s: %d bytes, %v", name, len(b), err)
		}
	}
}
