package agent

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// defaultDialTimeout bounds the default CONNECT target dial.
const defaultDialTimeout = 10 * time.Second

// copyBufSize is the chunk size for CONNECT copies; every chunk is flushed.
const copyBufSize = 32 << 10

// DialError is returned by Config.Dial to tell the gateway why the target
// could not be reached. serveConnect passes Reason in Sbx-Dial-Error on the
// 502 answer.
type DialError struct {
	// Reason is a short token such as "refused" or "timeout".
	Reason string
	// Err is the underlying dial error, if any.
	Err error
}

func (e *DialError) Error() string {
	if e.Err == nil {
		return "dial failed: " + e.Reason
	}
	return "dial failed: " + e.Reason + ": " + e.Err.Error()
}

func (e *DialError) Unwrap() error { return e.Err }

func defaultDial(ctx context.Context, host string, port int) (net.Conn, error) {
	d := net.Dialer{Timeout: defaultDialTimeout}
	return d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
}

// serveConnect handles an HTTP/2 CONNECT: parse the authority, check the
// policy, dial the target and copy both ways with half-close.
func (c *Client) serveConnect(w http.ResponseWriter, r *http.Request) {
	host, portStr, err := net.SplitHostPort(r.Host)
	if err != nil {
		http.Error(w, "bad authority", http.StatusBadRequest)
		return
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		http.Error(w, "bad port", http.StatusBadRequest)
		return
	}
	if err := c.cfg.DialPolicy(host, port); err != nil {
		status := http.StatusForbidden
		var pe *PolicyError
		if errors.As(err, &pe) && pe.Status != 0 {
			status = pe.Status
		}
		http.Error(w, err.Error(), status)
		return
	}
	target, err := c.cfg.Dial(r.Context(), host, port)
	if err != nil {
		c.log.Debug("tunnel connect: dial failed", "host", host, "port", port, "err", err)
		reason := classifyDialError(err)
		var de *DialError
		if errors.As(err, &de) && de.Reason != "" {
			reason = wire.NormalizeDialError(de.Reason)
		}
		if reason != "" {
			w.Header().Set(wire.HeaderDialError, reason)
		}
		http.Error(w, "dial failed", http.StatusBadGateway)
		return
	}
	defer func() { _ = target.Close() }()
	// The stream dies with its tunnel conn: unblock the copies then.
	stop := context.AfterFunc(r.Context(), func() { _ = target.Close() })
	defer stop()

	rc := http.NewResponseController(w)
	w.WriteHeader(http.StatusOK)
	if err := rc.Flush(); err != nil {
		return
	}

	upDone := make(chan struct{})
	go func() {
		defer close(upDone)
		_, err := io.Copy(target, r.Body)
		if err == nil {
			// Request body EOF: the gateway half-closed.
			if cw, ok := target.(interface{ CloseWrite() error }); ok {
				_ = cw.CloseWrite()
			}
		} else {
			_ = target.Close()
		}
	}()

	buf := make([]byte, copyBufSize)
	for {
		n, rerr := target.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				break
			}
			if ferr := rc.Flush(); ferr != nil {
				break
			}
		}
		if rerr != nil {
			break
		}
	}
	// Target EOF or a failed side: end the stream and wait for the upload copy.
	_ = target.Close()
	_ = r.Body.Close()
	<-upDone
}
