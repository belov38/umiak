package upstream

import (
	"bytes"
	"sync"
)

// maxHeadLineKeep is how much of each head line the scanner keeps: enough
// for a status line's code and the header names it looks for.
const maxHeadLineKeep = 64

// headScanner watches the HTTP/1.1 response heads read from an application
// conn for a head that carries both Content-Length and Transfer-Encoding
// (RFC 9112 6.3: a sign of response smuggling). net/http then silently
// drops Content-Length and reads the body as chunked; the gateway refuses
// such a response instead.
//
// It is armed before a request is written (expect) and scans the bytes read
// next up to the end of the final response head; 1xx heads other than 101
// are followed by another head. A conn that sent an ambiguous head stays
// marked.
type headScanner struct {
	mu        sync.Mutex
	active    bool
	statusNow bool // the next complete line is a status line
	info      bool // the current head is a non-final 1xx
	line      []byte
	cl, te    bool
	ambiguous bool
}

// expect arms the scanner for the next response head, unless it is already
// scanning one.
func (s *headScanner) expect() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active {
		return
	}
	s.active, s.statusNow, s.info, s.cl, s.te = true, true, false, false, false
	s.line = s.line[:0]
}

// feed scans bytes read from the conn.
func (s *headScanner) feed(b []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := 0; i < len(b) && s.active; i++ {
		ch := b[i]
		if ch != '\n' {
			if len(s.line) < maxHeadLineKeep {
				s.line = append(s.line, ch)
			}
			continue
		}
		line := bytes.TrimSuffix(s.line, []byte("\r"))
		s.line = s.line[:0]
		switch {
		case s.statusNow:
			s.statusNow = false
			s.info = nonFinalStatus(line)
		case len(line) == 0:
			// The end of a head.
			if s.cl && s.te {
				s.ambiguous = true
			}
			s.cl, s.te = false, false
			if s.info {
				s.statusNow = true
				continue
			}
			s.active = false
		case line[0] == ' ' || line[0] == '\t':
			// An obs-fold continuation of the previous field's value.
		default:
			name, _, _ := bytes.Cut(line, []byte(":"))
			name = bytes.TrimSpace(name)
			switch {
			case bytes.EqualFold(name, []byte("Content-Length")):
				s.cl = true
			case bytes.EqualFold(name, []byte("Transfer-Encoding")):
				s.te = true
			}
		}
	}
}

// nonFinalStatus reports a "HTTP/1.x 1yy" status line other than 101: the
// head is followed by another response head.
func nonFinalStatus(line []byte) bool {
	_, rest, ok := bytes.Cut(line, []byte(" "))
	if !ok || len(rest) < 3 || rest[0] != '1' {
		return false
	}
	return !bytes.HasPrefix(rest, []byte("101"))
}

func (s *headScanner) ambiguousFraming() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ambiguous
}

// WatchResponseHeads makes the conn check the HTTP/1.1 response heads it
// reads (see ExpectResponse). AppTransports does it for HTTP/1.1 conns. It
// must be called before the conn is in use.
func (c *Conn) WatchResponseHeads() {
	c.head = &headScanner{}
	c.head.expect()
}

// ExpectResponse tells a watched conn that a request is about to be
// written: the bytes read next start a response head. It does nothing on a
// conn that is not watched.
func (c *Conn) ExpectResponse() {
	if c.head != nil {
		c.head.expect()
	}
}

// AmbiguousFraming reports that a watched conn has read a response head
// with both Content-Length and Transfer-Encoding.
func (c *Conn) AmbiguousFraming() bool {
	return c.head != nil && c.head.ambiguousFraming()
}
