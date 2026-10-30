package sshgw

import (
	"io"
	"slices"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// fakeChan is an ssh.Channel that records the EOF and requests sent on it.
// Its reads end at once.
type fakeChan struct {
	mu  sync.Mutex
	ops []string
}

func (f *fakeChan) record(op string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, op)
}

func (f *fakeChan) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.ops)
}

func (*fakeChan) Read([]byte) (int, error)    { return 0, io.EOF }
func (*fakeChan) Write(p []byte) (int, error) { return len(p), nil }
func (f *fakeChan) Close() error              { f.record("close"); return nil }
func (f *fakeChan) CloseWrite() error         { f.record("eof"); return nil }
func (f *fakeChan) Stderr() io.ReadWriter     { return fakeStderr{} }
func (f *fakeChan) SendRequest(name string, _ bool, _ []byte) (bool, error) {
	f.record("req:" + name)
	return true, nil
}

type fakeStderr struct{}

func (fakeStderr) Read([]byte) (int, error)    { return 0, io.EOF }
func (fakeStderr) Write(p []byte) (int, error) { return len(p), nil }

// TestPipeEOFAfterQueuedRequests: a request queued before the source's EOF
// (x/crypto queues it before it processes the EOF packet) is sent before
// the EOF, whichever goroutine runs first.
func TestPipeEOFAfterQueuedRequests(t *testing.T) {
	for i := range 500 {
		a, b := &fakeChan{}, &fakeChan{}
		areqs := make(chan *ssh.Request, 1)
		areqs <- &ssh.Request{Type: "exec"}
		close(areqs)
		breqs := make(chan *ssh.Request)
		close(breqs)
		p := pipe{a: a, areqs: areqs, b: b, breqs: breqs}
		p.run()
		if got := b.recorded(); !slices.Equal(got, []string{"req:exec", "eof", "close"}) {
			t.Fatalf("run %d: backend saw %q", i, got)
		}
	}
}
