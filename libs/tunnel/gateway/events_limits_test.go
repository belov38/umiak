package gateway

import (
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"

	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/journal"
)

// subscribeCounter counts Events/Subscribe calls served by the agent: each
// one without after_seq reads AckedSeq once.
type subscribeCounter struct {
	*journal.Mem
	subs atomic.Int64
}

func (c *subscribeCounter) AckedSeq() uint64 {
	c.subs.Add(1)
	return c.Mem.AckedSeq()
}

func blob(n int) *wrapperspb.BytesValue { return wrapperspb.Bytes(make([]byte, n)) }

func TestEventBatchesCappedByBytes(t *testing.T) {
	e := newEnv(t)
	const maxBytes = 1 << 20
	gw := e.gateway("gw-a", func(c *Config) {
		c.Timing.EventBatchMaxBytes = maxBytes
		c.Timing.EventBatchInterval = time.Second
	})
	id, bs := e.machine()
	j := journal.New()
	const n = 24
	for range n {
		j.Append("test.blob", blob(300<<10))
	}
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Journal = j
	e.startAgent(cfg).waitConnected()

	eventually(t, waitTimeout, "journal acked", func() bool { return j.AckedSeq() == n })
	_, batches := gw.sink.snapshot()
	for i, b := range batches {
		size := 0
		for _, ev := range b {
			size += proto.Size(ev)
		}
		if size > maxBytes {
			t.Errorf("batch %d: %d events, %d bytes > %d", i, len(b), size, maxBytes)
		}
	}
	checkContiguous(t, seqs(batches), n)
	if len(batches) < n/3 {
		t.Errorf("%d batches for %d events of 300 KiB, want at least %d", len(batches), n, n/3)
	}
}

// An agent that sends an event above MaxEventBytes (old or malicious): the
// gateway does not read it, ends the stream and resubscribes with backoff.
func TestOversizeEventEndsStreamWithBackoff(t *testing.T) {
	e := newEnv(t)
	gw := e.gateway("gw-a", func(c *Config) { c.Timing.MaxEventBytes = 1 << 20 })
	id, bs := e.machine()
	j := &subscribeCounter{Mem: journal.New()}
	j.Append("test.small", nil)
	j.Append("test.huge", blob(4<<20))
	cfg := agentConfig(e, id, bs, defaultIdentity())
	cfg.Journal = j
	cfg.MaxEventBytes = 8 << 20 // the agent does not stub it
	e.startAgent(cfg).waitConnected()

	eventually(t, waitTimeout, "small event acked", func() bool { return j.Mem.AckedSeq() >= 1 })
	eventually(t, waitTimeout, "resubscribes", func() bool { return j.subs.Load() >= 5 })
	heap := func() uint64 {
		// Twice: the second cycle also frees sync.Pool victims (connect
		// keeps its message buffers pooled).
		runtime.GC()
		runtime.GC()
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		return ms.HeapAlloc
	}
	before, subs := heap(), j.subs.Load()
	time.Sleep(time.Second)
	after, window := heap(), j.subs.Load()-subs

	// fastTiming backs off from 10 ms up to 50 ms: about 20 attempts a second.
	if window < 1 || window > 40 {
		t.Errorf("%d subscribes in 1s, want backoff-paced (1..40)", window)
	}
	if after > before+16<<20 {
		t.Errorf("heap grew from %d to %d over %d subscribes", before, after, window)
	}
	if j.Mem.AckedSeq() != 1 {
		t.Errorf("acked seq %d, want 1: the oversize event must not be delivered", j.Mem.AckedSeq())
	}
	_, batches := gw.sink.snapshot()
	for _, b := range batches {
		for _, ev := range b {
			if ev.GetSeq() == 2 {
				t.Fatalf("oversize event delivered to the sink")
			}
		}
	}
	t.Logf("%d subscribes in 1s, heap %d → %d", window, before, after)
}
