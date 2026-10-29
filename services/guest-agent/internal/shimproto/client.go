package shimproto

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"syscall"
	"time"
)

// ErrClosed is returned by calls on a client whose connection is gone.
var ErrClosed = errors.New("shimproto: connection closed")

// Status is the answer to a status request.
type Status struct {
	// Pid is the main process; 0 if it never started.
	Pid int
	// State is StateRunning or StateExited.
	State string
	// LastSeq is the highest applied input seq per session.
	LastSeq map[string]uint64
	// Leftovers reports processes still alive in the payload after the main
	// process exited.
	Leftovers bool
	// Exited reports that exit.json is written.
	Exited bool
}

// Client is the agent side of one shim connection. Its methods are safe for
// concurrent use; the shim handles requests one at a time.
type Client struct {
	conn    net.Conn
	version int

	wmu sync.Mutex // serializes frame writes

	mu      sync.Mutex
	nextID  uint64
	pending map[uint64]chan Message
	err     error // set once the read loop ends

	exited chan ExitFile
	done   chan struct{}
}

// Dial connects to the shim socket and negotiates the protocol version. A
// shim without a common version fails with an *Error of CodeShimOutdated.
func Dial(ctx context.Context, sock string) (*Client, error) {
	return dial(ctx, sock, MinVersion, Version)
}

func dial(ctx context.Context, sock string, minV, maxV int) (*Client, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", sock)
	if err != nil {
		return nil, err
	}
	v, err := hello(ctx, conn, minV, maxV)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	c := &Client{
		conn:    conn,
		version: v,
		nextID:  1,
		pending: make(map[uint64]chan Message),
		exited:  make(chan ExitFile, 1),
		done:    make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

// hello runs the hello exchange under the deadline of ctx.
func hello(ctx context.Context, conn net.Conn, minV, maxV int) (int, error) {
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	defer stop()
	if err := Write(conn, Message{Type: TypeHello, Min: minV, Max: maxV}); err != nil {
		return 0, ctxErr(ctx, err)
	}
	m, err := Read(conn)
	if err != nil {
		return 0, ctxErr(ctx, err)
	}
	if !stop() {
		return 0, ctx.Err()
	}
	_ = conn.SetDeadline(time.Time{})
	switch m.Type {
	case TypeHello:
		if m.Version < minV || m.Version > maxV {
			return 0, &Error{Code: CodeShimOutdated, Message: fmt.Sprintf("shim chose version %d", m.Version)}
		}
		return m.Version, nil
	case TypeError:
		return 0, &Error{Code: m.Code, Message: m.Text}
	default:
		return 0, fmt.Errorf("shimproto: unexpected hello reply %q", m.Type)
	}
}

// ctxErr prefers the context error over the I/O error it caused.
func ctxErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// Version is the negotiated protocol version.
func (c *Client) Version() int { return c.version }

// Exited delivers the exit of the main process when the shim pushes it on
// this connection. A client connected after the exit gets nothing here and
// sees Status.Exited instead.
func (c *Client) Exited() <-chan ExitFile { return c.exited }

// Done is closed when the connection is gone (Close, shim exit or a
// protocol error).
func (c *Client) Done() <-chan struct{} { return c.done }

// Close closes the connection; pending calls fail with ErrClosed.
func (c *Client) Close() error {
	err := c.conn.Close()
	<-c.done
	return err
}

// Status asks for the state of the command.
func (c *Client) Status(ctx context.Context) (Status, error) {
	r, err := c.call(ctx, Message{Type: TypeStatus}, TypeStatusReply)
	if err != nil {
		return Status{}, err
	}
	return Status{Pid: r.Pid, State: r.State, LastSeq: r.LastSeq, Leftovers: r.Leftovers, Exited: r.Exited}, nil
}

// Input writes data to the command. applied is false when seq is not above
// the last applied seq of session (a duplicate).
func (c *Client) Input(ctx context.Context, session string, seq uint64, data []byte, closeStdin bool) (applied bool, err error) {
	r, err := c.call(ctx, Message{Type: TypeInput, Session: session, Seq: seq, Data: data, CloseStdin: closeStdin}, TypeInputReply)
	if err != nil {
		return false, err
	}
	return r.Applied, nil
}

// Resize sets the PTY window size.
func (c *Client) Resize(ctx context.Context, cols, rows uint16) error {
	_, err := c.call(ctx, Message{Type: TypeResize, Cols: cols, Rows: rows}, TypeOK)
	return err
}

// Kill sends firstSignal (0 = SIGTERM) to the process group and kills the
// payload cgroup after graceMs. reason ends up in exit.json if the kill ends
// the main process.
func (c *Client) Kill(ctx context.Context, graceMs uint32, firstSignal syscall.Signal, reason string) error {
	_, err := c.call(ctx, Message{Type: TypeKill, GraceMs: graceMs, FirstSignal: int(firstSignal), Reason: reason}, TypeOK)
	return err
}

// Signal sends sig to the process group of the main process, or kills the
// whole payload cgroup when cgroup is true.
func (c *Client) Signal(ctx context.Context, sig syscall.Signal, cgroup bool) error {
	_, err := c.call(ctx, Message{Type: TypeSignal, Sig: int(sig), Cgroup: cgroup}, TypeOK)
	return err
}

// call sends req and waits for the reply with the same ID.
func (c *Client) call(ctx context.Context, req Message, want string) (Message, error) {
	ch := make(chan Message, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return Message{}, c.err
	}
	req.ID = c.nextID
	c.nextID++
	c.pending[req.ID] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, req.ID)
		c.mu.Unlock()
	}()

	if err := c.write(ctx, req); err != nil {
		return Message{}, err
	}

	select {
	case r := <-ch:
		switch r.Type {
		case want:
			return r, nil
		case TypeError:
			return Message{}, &Error{Code: r.Code, Message: r.Text, Written: r.Written}
		default:
			return Message{}, fmt.Errorf("shimproto: %s: unexpected reply %q", req.Type, r.Type)
		}
	case <-c.done:
		return Message{}, c.closedErr()
	case <-ctx.Done():
		return Message{}, ctx.Err()
	}
}

// write sends one frame under the deadline of ctx. A failed write may leave
// half a frame on the stream, so it closes the connection.
func (c *Client) write(ctx context.Context, m Message) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	dl, _ := ctx.Deadline()
	_ = c.conn.SetWriteDeadline(dl)
	fired := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		defer close(fired)
		_ = c.conn.SetWriteDeadline(time.Unix(1, 0))
	})
	err := Write(c.conn, m)
	if !stop() {
		// The callback runs or has run: wait for it, so it cannot set a
		// past deadline on the next caller's write.
		<-fired
	}
	if err != nil {
		_ = c.conn.Close()
		return ctxErr(ctx, err)
	}
	return nil
}

func (c *Client) closedErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// readLoop routes replies to their callers and pushes to Exited.
func (c *Client) readLoop() {
	defer close(c.done)
	for {
		m, err := Read(c.conn)
		if err != nil {
			c.mu.Lock()
			c.err = fmt.Errorf("%w: %w", ErrClosed, err)
			c.mu.Unlock()
			return
		}
		if m.ID == 0 {
			if m.Type == TypeExited && m.Exit != nil {
				select {
				case c.exited <- *m.Exit:
				default: // the shim pushes once; a second push is dropped
				}
			}
			continue
		}
		c.mu.Lock()
		ch := c.pending[m.ID]
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
}
