package httpproxy_test

import (
	"io"
	"math/rand/v2"
	"runtime"
	"sync"
	"time"
)

// pattern is a cheap deterministic body of n bytes.
type pattern struct {
	left int64
	rng  *rand.ChaCha8
}

func newPattern(n int64) *pattern {
	return &pattern{left: n, rng: rand.NewChaCha8([32]byte{1, 2, 3})}
}

func (p *pattern) Read(b []byte) (int, error) {
	if p.left <= 0 {
		return 0, io.EOF
	}
	if int64(len(b)) > p.left {
		b = b[:p.left]
	}
	n, _ := p.rng.Read(b)
	p.left -= int64(n)
	return n, nil
}

// heapSampler records the peak HeapInuse above the baseline taken at start.
type heapSampler struct {
	base  uint64
	stopc chan struct{}
	wg    sync.WaitGroup
	mu    sync.Mutex
	peak  uint64
}

func startHeapSampler() *heapSampler {
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	s := &heapSampler{base: ms.HeapInuse, peak: ms.HeapInuse, stopc: make(chan struct{})}
	s.wg.Go(func() {
		t := time.NewTicker(50 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-s.stopc:
				return
			case <-t.C:
				var ms runtime.MemStats
				runtime.ReadMemStats(&ms)
				s.mu.Lock()
				s.peak = max(s.peak, ms.HeapInuse)
				s.mu.Unlock()
			}
		}
	})
	return s
}

// stop returns the peak growth in bytes.
func (s *heapSampler) stop() uint64 {
	close(s.stopc)
	s.wg.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peak - s.base
}
