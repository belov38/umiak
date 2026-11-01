package gateway

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/belov38/umiak/libs/tunnel/transport"
)

// duplexEcho echoes the request body as it arrives, like a bidi stream.
func duplexEcho(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	_ = rc.EnableFullDuplex()
	w.WriteHeader(http.StatusOK)
	_ = rc.Flush()
	buf := make([]byte, 1024)
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			_ = rc.Flush()
		}
		if err != nil {
			return
		}
	}
}

// readErrWithin reads r until it fails and returns the error and how long
// after since it came.
func readErrWithin(r io.Reader, since time.Time) (time.Duration, error) {
	_, err := io.Copy(io.Discard, r)
	if err == nil {
		err = io.EOF
	}
	return time.Since(since), err
}

// Streams whose request body is still open (TCP uploads, bidi calls) must
// end on their own schedule on a moved session: a cancelled context alone
// does not abort them in the HTTP/2 client, so they used to live until the
// session closed after the longest lingering stream.
func TestMovedSessionEndsEachStreamOnItsOwn(t *testing.T) {
	e := newEnv(t)
	gwA := e.gateway("gw-a", nil)
	gwB := e.gateway("gw-b", nil)
	gwB.routed.Store(false)
	id, bs := e.machine()
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Handler = http.HandlerFunc(duplexEcho)
	a := e.startAgent(cfg)
	a.waitConnected()
	mc := waitMachine(t, gwA, id).(*MachineConn)
	ctx := context.Background()

	port := startEcho(t)
	short, err := mc.DialTCPWith(ctx, port, TCPOptions{DrainDeadline: 300 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = short.Close() }()
	long, err := mc.DialTCPWith(ctx, port, TCPOptions{DrainDeadline: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = long.Close() }()
	echo(t, short, "short")
	echo(t, long, "long")

	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://agent/duplex", pr)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/connect+proto")
	resp, err := mc.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if _, err := io.WriteString(pw, "ping"); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 4)
	if _, err := io.ReadFull(resp.Body, got); err != nil || string(got) != "ping" {
		t.Fatalf("duplex echo = %q, %v", got, err)
	}

	gwA.routed.Store(false)
	gwB.routed.Store(true)
	if err := mc.Drain(ctx, transport.DrainOptions{Reason: "test"}); err != nil {
		t.Fatal(err)
	}
	eventually(t, waitTimeout, "A moves the session", func() bool {
		_, st := gwA.lookup(id)
		return st == stateMoved
	})
	movedAt := time.Now()

	// The streaming call ends right away.
	d, err := readErrWithin(resp.Body, movedAt)
	if !errors.Is(err, ErrMachineMoved) || d > time.Second {
		t.Fatalf("duplex stream ended %v after the move with %v, want ErrMachineMoved right away", d, err)
	}
	// The short TCP stream ends at its own deadline while the long one lingers.
	d, err = readErrWithin(short, movedAt)
	if !errors.Is(err, ErrMachineMoved) || d < 250*time.Millisecond || d > 2*time.Second {
		t.Fatalf("short tcp stream ended %v after the move with %v, want ErrMachineMoved ~300ms", d, err)
	}
	echo(t, long, "long still open")
}
