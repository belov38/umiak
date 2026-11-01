package gateway

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"

	"github.com/belov38/umiak/libs/tunnel/wire"
)

func envelope(flags byte, payload []byte) []byte {
	b := make([]byte, envelopePrefixLen, envelopePrefixLen+len(payload))
	b[0] = flags
	binary.BigEndian.PutUint32(b[1:], uint32(len(payload))) //nolint:gosec // test sizes are small
	return append(b, payload...)
}

// chunkReader returns its chunks one per Read, then err.
type chunkReader struct {
	chunks [][]byte
	err    error
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, r.err
	}
	n := copy(p, r.chunks[0])
	if n == len(r.chunks[0]) {
		r.chunks = r.chunks[1:]
	} else {
		r.chunks[0] = r.chunks[0][n:]
	}
	return n, nil
}

// runCopy copies body like the proxy does and reports whether it panicked
// with http.ErrAbortHandler.
func runCopy(t *testing.T, body io.Reader, contentType string) (out []byte, aborted bool) {
	t.Helper()
	h := &internalHandler{g: &Gateway{log: testLogger()}, errw: connect.NewErrorWriter()}
	rec := httptest.NewRecorder()
	rc := http.NewResponseController(rec)
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil)
	func() {
		defer func() {
			if v := recover(); v != nil {
				if v != http.ErrAbortHandler { //nolint:errorlint // panic value identity
					panic(v)
				}
				aborted = true
			}
		}()
		if err := h.copyBody(rec, rc, body, isConnectStream(contentType)); err != nil {
			h.abortBody(rec, rc, req, "m", contentType, err)
		}
	}()
	return rec.Body.Bytes(), aborted
}

func TestEnvelopeAbort(t *testing.T) {
	m1 := envelope(0, bytes.Repeat([]byte{1}, 100))
	m2 := envelope(0, bytes.Repeat([]byte{2}, 70000))
	end := envelope(envelopeFlagEndStr, []byte(`{}`))
	cut := errors.Join(ErrSessionClosed, errors.New("stream reset"))
	const ct = "application/connect+proto"

	t.Run("at a boundary: end-stream with unavailable", func(t *testing.T) {
		// Split reads across the prefix and payload to exercise the tracker.
		all := append(append([]byte{}, m1...), m2...)
		out, aborted := runCopy(t, &chunkReader{chunks: [][]byte{all[:3], all[3:200], all[200:]}, err: cut}, ct)
		if aborted {
			t.Fatal("aborted at a boundary")
		}
		if !bytes.Equal(out[:len(all)], all) {
			t.Fatal("messages were not copied intact")
		}
		rest := out[len(all):]
		if len(rest) < envelopePrefixLen || rest[0] != envelopeFlagEndStr ||
			int(binary.BigEndian.Uint32(rest[1:5])) != len(rest)-envelopePrefixLen {
			t.Fatalf("tail is not one end-stream envelope: %q", rest)
		}
		var es struct {
			Error struct {
				Code    string            `json:"code"`
				Message string            `json:"message"`
				Details []json.RawMessage `json:"details"`
			} `json:"error"`
			Metadata map[string][]string `json:"metadata"`
		}
		if err := json.Unmarshal(rest[envelopePrefixLen:], &es); err != nil {
			t.Fatal(err)
		}
		if es.Error.Code != "unavailable" || es.Error.Message != wire.CodeAgentUnavailable || len(es.Error.Details) != 1 ||
			len(es.Metadata[wire.HeaderErrorCode]) != 1 || es.Metadata[wire.HeaderErrorCode][0] != wire.CodeAgentUnavailable {
			t.Fatalf("end-stream = %s", rest[envelopePrefixLen:])
		}
		t.Logf("end-stream envelope: flags %#x, json %s", rest[0], rest[envelopePrefixLen:])
		h := &internalHandler{g: &Gateway{log: testLogger()}, errw: connect.NewErrorWriter()}
		moved := h.endStreamEnvelope(ct, unavailableError(wire.CodeMachineMoved, "http://10.0.0.7:8081"))
		t.Logf("moved end-stream envelope: flags %#x, json %s", moved[0], moved[envelopePrefixLen:])
	})
	t.Run("inside the prefix: reset", func(t *testing.T) {
		if _, aborted := runCopy(t, &chunkReader{chunks: [][]byte{m1, m2[:3]}, err: cut}, ct); !aborted {
			t.Fatal("not aborted inside a prefix")
		}
	})
	t.Run("inside the payload: reset", func(t *testing.T) {
		if _, aborted := runCopy(t, &chunkReader{chunks: [][]byte{m1, m2[:1000]}, err: cut}, ct); !aborted {
			t.Fatal("not aborted inside a payload")
		}
	})
	t.Run("after the upstream end-stream: nothing added", func(t *testing.T) {
		all := append(append([]byte{}, m1...), end...)
		out, aborted := runCopy(t, &chunkReader{chunks: [][]byte{all}, err: cut}, ct)
		if aborted || !bytes.Equal(out, all) {
			t.Fatalf("aborted %v, out %q", aborted, out)
		}
	})
	t.Run("not a connect stream: reset", func(t *testing.T) {
		for _, ct := range []string{"application/grpc", "application/proto", "application/octet-stream"} {
			if _, aborted := runCopy(t, &chunkReader{chunks: [][]byte{m1}, err: cut}, ct); !aborted {
				t.Fatalf("%s: not aborted", ct)
			}
		}
	})
	t.Run("clean EOF", func(t *testing.T) {
		out, aborted := runCopy(t, &chunkReader{chunks: [][]byte{m1, end}, err: io.EOF}, ct)
		if aborted || len(out) != len(m1)+len(end) {
			t.Fatalf("aborted %v, %d bytes", aborted, len(out))
		}
	})
}
