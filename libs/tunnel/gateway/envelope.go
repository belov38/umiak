package gateway

import (
	"bytes"
	"encoding/binary"
	"errors"
	"net/http"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// Connect streaming envelopes: 1 flag byte, 4 bytes big-endian length, payload.
const (
	envelopePrefixLen  = 5
	envelopeFlagEndStr = 0x02
)

// envelopeTracker follows the envelopes of a Connect streaming body as it
// is copied, to tell whether the bytes copied so far end on an envelope
// boundary.
type envelopeTracker struct {
	prefix    [envelopePrefixLen]byte
	prefixLen int    // bytes of the current prefix seen
	remain    uint32 // payload bytes left in the current envelope
	endStream bool   // the current envelope is the end-stream one
	ended     bool   // the end-stream envelope was copied completely
}

func (t *envelopeTracker) feed(p []byte) {
	for len(p) > 0 {
		if t.remain > 0 {
			n := min(uint32(len(p)), t.remain) //nolint:gosec // len(p) is a read size
			p = p[n:]
			t.remain -= n
			if t.remain == 0 && t.endStream {
				t.ended = true
			}
			continue
		}
		n := copy(t.prefix[t.prefixLen:], p)
		p = p[n:]
		t.prefixLen += n
		if t.prefixLen < envelopePrefixLen {
			return
		}
		t.prefixLen = 0
		t.endStream = t.prefix[0]&envelopeFlagEndStr != 0
		t.remain = binary.BigEndian.Uint32(t.prefix[1:])
		if t.remain == 0 && t.endStream {
			t.ended = true
		}
	}
}

// atBoundary reports whether the copied bytes end between two envelopes.
func (t *envelopeTracker) atBoundary() bool { return t.prefixLen == 0 && t.remain == 0 }

// abortBody ends a response whose upstream body failed after the response
// started (session moved or closed, tunnel broken). A Connect stream cut on
// an envelope boundary gets one end-stream envelope with Connect
// unavailable (machine_moved or agent_unavailable) and ends normally, so
// the client sees a retryable error after its last complete message. In
// every other case, a Connect stream cut inside an envelope, gRPC, unary or
// /files bodies, the stream is reset (http.ErrAbortHandler): the client
// gets a transport error, never a truncated body that looks complete.
func (h *internalHandler) abortBody(w http.ResponseWriter, rc *http.ResponseController, r *http.Request, id, contentType string, err error) {
	var ue *upstreamError
	if !errors.As(err, &ue) || ue.tr == nil {
		h.g.log.Debug("gateway: proxied body aborted", "machine_id", id, "err", err)
		panic(http.ErrAbortHandler)
	}
	if ue.tr.ended {
		return // the stream already ended; nothing is lost
	}
	if !ue.tr.atBoundary() {
		h.g.log.Info("gateway: connect stream reset inside an envelope", "machine_id", id, "err", err)
		panic(http.ErrAbortHandler)
	}
	code, owner := wire.CodeAgentUnavailable, ""
	if errors.Is(err, ErrMachineMoved) {
		code = wire.CodeMachineMoved
		owner = h.otherOwner(r.Context(), id)
	}
	end := h.endStreamEnvelope(contentType, unavailableError(code, owner))
	if end == nil {
		panic(http.ErrAbortHandler)
	}
	h.g.log.Info("gateway: connect stream ended with unavailable", "machine_id", id, "code", code, "err", err)
	if _, werr := w.Write(end); werr != nil {
		return
	}
	_ = rc.Flush()
}

// endStreamEnvelope encodes err as a Connect end-stream envelope (flags
// 0x02, JSON {"error": {...}, "metadata": {...}}) with connect's own
// ErrorWriter.
func (h *internalHandler) endStreamEnvelope(contentType string, err *connect.Error) []byte {
	req := &http.Request{Method: http.MethodPost, Header: http.Header{"Content-Type": {contentType}}}
	var c captureWriter
	if werr := h.errw.Write(&c, req, err); werr != nil {
		return nil
	}
	b := c.buf.Bytes()
	if len(b) < envelopePrefixLen || b[0]&envelopeFlagEndStr == 0 {
		return nil
	}
	return b
}

// captureWriter collects what connect's ErrorWriter writes.
type captureWriter struct {
	header http.Header
	buf    bytes.Buffer
}

func (c *captureWriter) Header() http.Header {
	if c.header == nil {
		c.header = http.Header{}
	}
	return c.header
}

func (c *captureWriter) WriteHeader(int) {}

func (c *captureWriter) Write(p []byte) (int, error) { return c.buf.Write(p) }
