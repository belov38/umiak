package shimproto

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
	"time"
)

func TestFrameRoundTrip(t *testing.T) {
	ended := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		m    Message
	}{
		{"hello", Message{Type: TypeHello, ID: 1, Min: 1, Max: 3}},
		{"status reply", Message{Type: TypeStatusReply, ID: 2, Pid: 42, State: StateRunning,
			LastSeq: map[string]uint64{"s1": 7}, Leftovers: true}},
		{"input", Message{Type: TypeInput, ID: 3, Session: "s", Seq: 9, Data: []byte{0, 1, 0xff}, CloseStdin: true}},
		{"kill", Message{Type: TypeKill, ID: 4, GraceMs: 100, FirstSignal: int(syscall.SIGHUP), Reason: ReasonPTYIdle}},
		{"error", Message{Type: TypeError, ID: 5, Code: CodeInternal, Text: "partial", Written: 7}},
		{"exited", Message{Type: TypeExited, Exit: &ExitFile{Status: StatusKilled, Code: 137, Signal: "SIGKILL",
			Reason: ReasonOOM, StdoutEnd: 10, StderrEnd: 20, EndedAt: ended}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := Write(&buf, tt.m); err != nil {
				t.Fatalf("Write: %v", err)
			}
			if n := binary.BigEndian.Uint32(buf.Bytes()[:4]); int(n) != buf.Len()-4 {
				t.Fatalf("length prefix %d, body %d", n, buf.Len()-4)
			}
			got, err := Read(&buf)
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			if !reflect.DeepEqual(got, tt.m) {
				t.Errorf("round trip:\n got  %+v\n want %+v", got, tt.m)
			}
		})
	}
}

func TestFrameTooLarge(t *testing.T) {
	var buf bytes.Buffer
	err := Write(&buf, Message{Type: TypeInput, Data: make([]byte, MaxFrame)})
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Errorf("Write oversized: err = %v, want ErrFrameTooLarge", err)
	}
	if buf.Len() != 0 {
		t.Errorf("Write oversized wrote %d bytes", buf.Len())
	}

	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], MaxFrame+1)
	if _, err := Read(bytes.NewReader(hdr[:])); !errors.Is(err, ErrFrameTooLarge) {
		t.Errorf("Read oversized: err = %v, want ErrFrameTooLarge", err)
	}

	if _, err := Read(bytes.NewReader([]byte{0, 0, 0, 2, '{', '}'})); err == nil {
		t.Error("Read of a frame without type: want error")
	}
}

// listen starts a unix listener in a short temporary directory (macOS limits
// socket paths to 104 bytes).
func listen(t *testing.T) (*net.UnixListener, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "sp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return ln, sock
}

// serveOne accepts one connection, negotiates with [min, max] and then
// answers every request with handler until the client goes away.
func serveOne(t *testing.T, ln *net.UnixListener, minV, maxV int, handler func(Message) []Message) {
	t.Helper()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		if _, err := Accept(c, minV, maxV); err != nil {
			return
		}
		for {
			m, err := Read(c)
			if err != nil {
				return
			}
			for _, r := range handler(m) {
				if err := Write(c, r); err != nil {
					return
				}
			}
		}
	}()
}

func TestHelloOutdated(t *testing.T) {
	ln, sock := listen(t)
	serveOne(t, ln, 1, 1, func(Message) []Message { return nil })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := dial(ctx, sock, 2, 2)
	if err == nil {
		_ = c.Close()
		t.Fatal("dial: want shim_outdated error")
	}
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != CodeShimOutdated {
		t.Errorf("dial: err = %v, want code %s", err, CodeShimOutdated)
	}
}

func TestNegotiate(t *testing.T) {
	tests := []struct {
		name                   string
		cMin, cMax, sMin, sMax int
		want                   int
		ok                     bool
	}{
		{"same", 1, 1, 1, 1, 1, true},
		{"client newer", 1, 3, 1, 2, 2, true},
		{"shim newer", 1, 2, 1, 3, 2, true},
		{"client too new", 2, 2, 1, 1, 0, false},
		{"shim too new", 1, 1, 2, 3, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := Negotiate(tt.cMin, tt.cMax, tt.sMin, tt.sMax)
			if got != tt.want || ok != tt.ok {
				t.Errorf("Negotiate = %d, %v; want %d, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestClientCalls(t *testing.T) {
	ln, sock := listen(t)
	exit := ExitFile{Status: StatusExited, Code: 3, Reason: ReasonNone, StdoutEnd: 5}
	serveOne(t, ln, 1, Version, func(m Message) []Message {
		switch m.Type {
		case TypeStatus:
			return []Message{{Type: TypeStatusReply, ID: m.ID, Pid: 10, State: StateRunning,
				LastSeq: map[string]uint64{"a": 1}}}
		case TypeInput:
			// The push arrives before the reply: the client must route both.
			return []Message{
				{Type: TypeExited, Exit: &exit},
				{Type: TypeInputReply, ID: m.ID, Applied: m.Seq > 1 && string(m.Data) == "x" && m.CloseStdin},
			}
		case TypeKill:
			if m.GraceMs != 50 || m.FirstSignal != int(syscall.SIGTERM) || m.Reason != ReasonTimeout {
				return []Message{{Type: TypeError, ID: m.ID, Code: CodeInvalidArgument, Text: "bad kill"}}
			}
			return []Message{{Type: TypeOK, ID: m.ID}}
		case TypeSignal:
			return []Message{{Type: TypeError, ID: m.ID, Code: CodeCommandExited, Text: "gone", Written: 3}}
		case TypeResize:
			if m.Cols != 100 || m.Rows != 40 {
				return []Message{{Type: TypeError, ID: m.ID, Code: CodeInvalidArgument}}
			}
			return []Message{{Type: TypeOK, ID: m.ID}}
		}
		return []Message{{Type: TypeError, ID: m.ID, Code: CodeUnknownType}}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, sock)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer func() { _ = c.Close() }()
	if c.Version() != Version {
		t.Errorf("Version = %d, want %d", c.Version(), Version)
	}

	st, err := c.Status(ctx)
	if err != nil || st.Pid != 10 || st.State != StateRunning || st.LastSeq["a"] != 1 {
		t.Errorf("Status = %+v, %v", st, err)
	}
	applied, err := c.Input(ctx, "s", 2, []byte("x"), true)
	if err != nil || !applied {
		t.Errorf("Input = %v, %v; want true", applied, err)
	}
	select {
	case got := <-c.Exited():
		if got != exit {
			t.Errorf("Exited = %+v, want %+v", got, exit)
		}
	case <-ctx.Done():
		t.Fatal("no exited push")
	}
	if err := c.Kill(ctx, 50, syscall.SIGTERM, ReasonTimeout); err != nil {
		t.Errorf("Kill: %v", err)
	}
	if err := c.Resize(ctx, 100, 40); err != nil {
		t.Errorf("Resize: %v", err)
	}
	err = c.Signal(ctx, syscall.SIGKILL, true)
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != CodeCommandExited || pe.Written != 3 {
		t.Errorf("Signal: err = %#v, want %s with written 3", err, CodeCommandExited)
	}

	// A cancelled context fails the call and closes the connection.
	cctx, ccancel := context.WithCancel(ctx)
	ccancel()
	if _, err := c.Status(cctx); !errors.Is(err, context.Canceled) {
		t.Errorf("Status with cancelled ctx: err = %v", err)
	}

	_ = c.Close()
	select {
	case <-c.Done():
	case <-ctx.Done():
		t.Fatal("Done not closed after Close")
	}
	if _, err := c.Status(ctx); err == nil {
		t.Error("Status after Close: want error")
	}
}
