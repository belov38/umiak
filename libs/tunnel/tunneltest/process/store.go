// Package process is a test double of the sbx.testing.v1.Process service
// that honours the command contract of spec 9.1: Start is idempotent by
// command_id, output is addressed by per-stream byte offsets, Attach resumes
// from any offset and sends exit only after all output, and old output may
// be dropped by retention (truncated).
//
// A Store plays the shim and the on-disk state of a real agent: it outlives
// agent clients, so a test can restart the agent and attach again. It is
// test-only and never imported by library code.
package process

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/proto"

	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
)

// Defaults.
const (
	defaultHeartbeatAfter = 15 * time.Second
	defaultLineBytes      = 64
	minLineBytes          = 32
	// maxChunk is the largest data event (spec 9.1).
	maxChunk = 64 << 10
)

// Options configures a Store.
type Options struct {
	// HeartbeatAfter is the silence after which Attach sends a heartbeat (15 s).
	HeartbeatAfter time.Duration
	// RetainBytes is how many bytes of each stream are kept (0 keeps all).
	// Older output is dropped and attaching below it yields truncated.
	RetainBytes uint64
	// Hold, when set, keeps every command from exiting until it is closed:
	// the command writes all its output, then waits for Hold (or a kill)
	// before its exit. Attach streams stay open meanwhile.
	Hold <-chan struct{}
}

// Store holds the commands of one machine.
type Store struct {
	opts Options

	mu   sync.Mutex
	cmds map[string]*command
	// invocations counts Start and Run calls per command_id, including
	// retries and calls that found the command already started.
	invocations map[string]int
}

// NewStore returns an empty store.
func NewStore(opts Options) *Store {
	if opts.HeartbeatAfter <= 0 {
		opts.HeartbeatAfter = defaultHeartbeatAfter
	}
	return &Store{opts: opts, cmds: map[string]*command{}, invocations: map[string]int{}}
}

// output is one stream: the retained bytes and the offset of the first one.
// data is append-only: retention replaces the slice instead of moving bytes,
// so slices handed out earlier stay valid.
type output struct {
	data  []byte
	start uint64
}

func (o *output) end() uint64 { return o.start + uint64(len(o.data)) }

// command is one started command.
type command struct {
	id   string
	spec *testingv1.CommandSpec

	starts atomic.Int32 // generators launched

	mu      sync.Mutex
	out     [2]output
	changed chan struct{} // closed and replaced on every change
	exited  bool
	status  testingv1.ExitStatus
	code    int32
	signal  string
	labels  uint64

	kill     chan struct{}
	killOnce sync.Once
	done     chan struct{} // closed when the command exited
	doneOnce sync.Once
	sent     atomic.Uint64 // data bytes handed to stream.Send
}

// errAlreadyExists is returned by start for a command_id with another spec.
var errAlreadyExists = errors.New("process: command exists with a different spec")

// start creates and starts a command, or returns the existing one with the
// same spec (created false).
func (s *Store) start(id string, spec *testingv1.CommandSpec) (*command, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.cmds[id]; ok {
		if !proto.Equal(c.spec, spec) {
			return nil, false, errAlreadyExists
		}
		return c, false, nil
	}
	c := &command{
		id:      id,
		spec:    proto.CloneOf(spec),
		changed: make(chan struct{}),
		kill:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	s.cmds[id] = c
	c.launch(s.opts.RetainBytes, s.opts.Hold)
	return c, true, nil
}

// launch starts the output generator; Starts counts launches.
func (c *command) launch(retain uint64, hold <-chan struct{}) {
	c.starts.Add(1)
	go c.run(retain, hold)
}

// invoked records a Start or Run call for id.
func (s *Store) invoked(id string) {
	s.mu.Lock()
	s.invocations[id]++
	s.mu.Unlock()
}

func (s *Store) get(id string) *command {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cmds[id]
}

// Starts returns how many times the command's work really began (its
// output generator was launched; the marker of spec 14.1): 0 for an unknown
// command, 1 after any number of retries.
func (s *Store) Starts(commandID string) int {
	if c := s.get(commandID); c != nil {
		return int(c.starts.Load())
	}
	return 0
}

// Invocations returns how many Start and Run calls for the command reached
// the agent, retries included. Invocations > Starts shows that retries
// happened and were deduplicated.
func (s *Store) Invocations(commandID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.invocations[commandID]
}

// SentBytes returns the data bytes Attach and Run handed to stream.Send for
// the command, over all calls.
func (s *Store) SentBytes(commandID string) uint64 {
	if c := s.get(commandID); c != nil {
		return c.sent.Load()
	}
	return 0
}

// Produced returns the end offsets of stdout and stderr so far.
func (s *Store) Produced(commandID string) (stdout, stderr uint64) {
	c := s.get(commandID)
	if c == nil {
		return 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.out[0].end(), c.out[1].end()
}

// LabelCalls returns how many SetLabel calls ran for the command.
func (s *Store) LabelCalls(commandID string) uint64 {
	c := s.get(commandID)
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.labels
}

// Done returns a channel closed when the command exited; nil for an unknown
// command.
func (s *Store) Done(commandID string) <-chan struct{} {
	if c := s.get(commandID); c != nil {
		return c.done
	}
	return nil
}

// Close kills every command so their generators stop.
func (s *Store) Close() {
	s.mu.Lock()
	cmds := make([]*command, 0, len(s.cmds))
	for _, c := range s.cmds {
		cmds = append(cmds, c)
	}
	s.mu.Unlock()
	for _, c := range cmds {
		c.signalKill("SIGKILL")
		<-c.done
	}
}

func streamName(i int) string {
	if i == 0 {
		return "stdout"
	}
	return "stderr"
}

func lineBytes(spec *testingv1.CommandSpec) int {
	if lb := int(spec.GetLineBytes()); lb > 0 {
		return lb
	}
	return defaultLineBytes
}

// line returns line n: its stream (0 stdout for even n, 1 stderr for odd n)
// and its bytes, "<stream> <n> " padded with '.' to lb-1 bytes, then "\n".
func line(n, lb int) (int, []byte) {
	i := n % 2
	b := make([]byte, lb)
	p := copy(b, fmt.Sprintf("%s %d ", streamName(i), n))
	for j := p; j < lb-1; j++ {
		b[j] = '.'
	}
	b[lb-1] = '\n'
	return i, b
}

// Expected returns the output a command with spec writes when it runs to
// its end.
func Expected(spec *testingv1.CommandSpec) (stdout, stderr []byte) {
	lb := lineBytes(spec)
	n := int(spec.GetLines())
	var out [2][]byte
	out[0] = make([]byte, 0, (n+1)/2*lb)
	out[1] = make([]byte, 0, n/2*lb)
	for k := range n {
		i, b := line(k, lb)
		out[i] = append(out[i], b...)
	}
	return out[0], out[1]
}

// run generates the output, one line per interval (as fast as possible with
// a yield when the interval is 0), and exits with the spec's code. Line k is
// due at start + k*interval, so slow timers do not stretch the command.
// With hold set it waits for hold to close before the exit.
func (c *command) run(retain uint64, hold <-chan struct{}) {
	lb := lineBytes(c.spec)
	n := int(c.spec.GetLines())
	interval := c.spec.GetInterval().AsDuration()
	begin := time.Now()
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for k := range n {
		if k > 0 {
			if wait := time.Until(begin.Add(time.Duration(k) * interval)); interval > 0 && wait > 0 {
				if timer == nil {
					timer = time.NewTimer(wait)
				} else {
					timer.Reset(wait)
				}
				select {
				case <-c.kill:
					c.finish()
					return
				case <-timer.C:
				}
			} else {
				runtime.Gosched()
			}
		}
		select {
		case <-c.kill:
			c.finish()
			return
		default:
		}
		i, b := line(k, lb)
		c.write(i, b, retain)
	}
	if hold != nil {
		select {
		case <-c.kill:
			c.finish()
			return
		case <-hold:
		}
	}
	c.mu.Lock()
	if c.status == testingv1.ExitStatus_EXIT_STATUS_UNSPECIFIED { // not killed meanwhile
		c.status, c.code = testingv1.ExitStatus_EXIT_STATUS_EXITED, c.spec.GetExitCode()
	}
	c.mu.Unlock()
	c.finish()
}

// write appends b to stream i and applies retention.
func (c *command) write(i int, b []byte, retain uint64) {
	c.mu.Lock()
	o := &c.out[i]
	o.data = append(o.data, b...)
	if retain > 0 && uint64(len(o.data)) > retain {
		drop := uint64(len(o.data)) - retain
		o.data = append([]byte(nil), o.data[drop:]...)
		o.start += drop
	}
	c.notifyLocked()
	c.mu.Unlock()
}

func (c *command) notifyLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}

// finish marks the command exited; the status is set before (killed by
// signalKill, exited by run).
func (c *command) finish() {
	c.mu.Lock()
	c.exited = true
	c.notifyLocked()
	c.mu.Unlock()
	c.doneOnce.Do(func() { close(c.done) })
}

// signalKill kills a running command: it exits with status killed. A
// command that already exited is not changed.
func (c *command) signalKill(sig string) {
	c.killOnce.Do(func() {
		c.mu.Lock()
		if !c.exited {
			c.status, c.signal = testingv1.ExitStatus_EXIT_STATUS_KILLED, sig
		}
		c.mu.Unlock()
		close(c.kill)
	})
}

// next returns the next event for an attach at off and advances off; nil
// with a channel to wait on when there is nothing to send yet. Streams take
// turns (turn is the stream to try first).
func (c *command) next(off *[2]uint64, turn *int) (*testingv1.AttachResponse, <-chan struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range 2 {
		i := (*turn + k) % 2
		o := &c.out[i]
		if off[i] < o.start {
			off[i] = o.start
			*turn = (i + 1) % 2
			return &testingv1.AttachResponse{Event: &testingv1.AttachResponse_Truncated{Truncated: &testingv1.TruncatedEvent{
				Stream: streamOf(i), AvailableFrom: o.start,
			}}}, nil
		}
		if off[i] < o.end() {
			from := off[i] - o.start
			size := min(o.end()-off[i], maxChunk)
			ev := &testingv1.AttachResponse{Event: &testingv1.AttachResponse_Data{Data: &testingv1.DataEvent{
				Stream: streamOf(i), Offset: off[i], Data: o.data[from : from+size],
			}}}
			off[i] += size
			*turn = (i + 1) % 2
			return ev, nil
		}
	}
	if c.exited && off[0] >= c.out[0].end() && off[1] >= c.out[1].end() {
		return &testingv1.AttachResponse{Event: &testingv1.AttachResponse_Exit{Exit: &testingv1.ExitEvent{
			Status: c.status, Code: c.code, Signal: c.signal,
			StdoutEnd: c.out[0].end(), StderrEnd: c.out[1].end(),
		}}}, nil
	}
	return nil, c.changed
}

func streamOf(i int) testingv1.Stream {
	if i == 0 {
		return testingv1.Stream_STREAM_STDOUT
	}
	return testingv1.Stream_STREAM_STDERR
}
