package upstream

import (
	"net"
	"strings"
	"testing"
)

func TestHeadScanner(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		ambiguous bool
		// active is whether the scanner still waits for the end of a head.
		active bool
	}{
		{name: "content length", in: "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"},
		{name: "chunked", in: "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nContent-Length: 1\r\n"},
		{name: "both", in: "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n", ambiguous: true},
		{name: "both, odd case and spaces", in: "HTTP/1.1 200 OK\nCONTENT-LENGTH : 5\ntransfer-encoding:chunked\n\n", ambiguous: true},
		{name: "on different heads", in: "HTTP/1.1 103 Early Hints\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"},
		{name: "in the final head after a 1xx", in: "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n", ambiguous: true},
		{name: "in a 1xx head", in: "HTTP/1.1 103 Early Hints\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\nHTTP/1.1 200 OK\r\n\r\n", ambiguous: true},
		{name: "101 is final", in: "HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\n\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"},
		{name: "in the body", in: "HTTP/1.1 200 OK\r\nContent-Length: 60\r\n\r\nTransfer-Encoding: chunked\r\n\r\n"},
		{name: "folded value", in: "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-A: a\r\n Transfer-Encoding: chunked\r\n\r\n"},
		{name: "long lines", in: "HTTP/1.1 200 OK\r\nX-Long: " + strings.Repeat("a", 1000) + "\r\nContent-Length: 5\r\nTransfer-Encoding: x\r\n\r\n", ambiguous: true},
		{name: "head not finished", in: "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n", active: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Whole, and split at every byte.
			for _, step := range []int{len(tc.in), 1} {
				s := &headScanner{}
				s.expect()
				for i := 0; i < len(tc.in); i += step {
					s.feed([]byte(tc.in[i:min(i+step, len(tc.in))]))
				}
				if s.ambiguousFraming() != tc.ambiguous || s.active != tc.active {
					t.Fatalf("step %d: ambiguous %v active %v, want %v %v", step, s.ambiguousFraming(), s.active, tc.ambiguous, tc.active)
				}
			}
		})
	}
}

func TestHeadScannerKeepAlive(t *testing.T) {
	s := &headScanner{}
	s.expect()
	s.feed([]byte("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody"))
	// Not armed: bytes between responses are not scanned.
	s.feed([]byte("Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"))
	if s.ambiguousFraming() {
		t.Fatal("bytes after the head were scanned")
	}
	s.expect()
	s.feed([]byte("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n"))
	if !s.ambiguousFraming() {
		t.Fatal("second response not checked")
	}
	// The mark stays.
	s.expect()
	s.feed([]byte("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nbody"))
	if !s.ambiguousFraming() {
		t.Fatal("mark cleared")
	}
}

// expect while a head is being scanned does not restart it.
func TestHeadScannerExpectMidHead(t *testing.T) {
	s := &headScanner{}
	s.expect()
	s.feed([]byte("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n"))
	s.expect()
	s.feed([]byte("Transfer-Encoding: chunked\r\n\r\n"))
	if !s.ambiguousFraming() {
		t.Fatal("restarted mid-head")
	}
}

func TestConnWatchResponseHeads(t *testing.T) {
	a, b := net.Pipe()
	defer func() { _ = a.Close() }()
	defer func() { _ = b.Close() }()
	c := &Conn{Conn: a}
	c.ExpectResponse() // not watched: no-op
	if c.AmbiguousFraming() {
		t.Fatal("unwatched conn marked")
	}
	c.WatchResponseHeads()
	go func() {
		_, _ = b.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n"))
	}()
	buf := make([]byte, 128)
	n := 0
	for !strings.HasSuffix(string(buf[:n]), "\r\n\r\n") {
		m, err := c.Read(buf[n:])
		if err != nil {
			t.Fatal(err)
		}
		n += m
	}
	if !c.AmbiguousFraming() {
		t.Fatal("not marked")
	}
}
