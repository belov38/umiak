//go:build linux

package output_test

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/output"
)

// TestReaderNeverSeesZerosWhileJanitorPunches appends known data to a stream
// while the janitor punches its front with a small cap and a reader follows
// the stream. Every byte the reader gets must equal the source at its offset.
func TestReaderNeverSeesZerosWhileJanitorPunches(t *testing.T) {
	e := newJanitorEnv(t)
	e.j.PerStream = 16 * kib
	e.add(t, "c1", false, time.Time{}, map[string]int{"stdout": 0})
	path := filepath.Join(e.layout.CommandDir("c1"), "stdout")

	const total = 8 << 20
	src := randomData(total)

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	var wg sync.WaitGroup
	var written atomic.Int64

	wg.Add(1)
	go func() {
		defer wg.Done()
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = f.Close() }()
		for off := 0; off < total && ctx.Err() == nil; off += 4096 {
			if _, err := f.Write(src[off : off+4096]); err != nil {
				t.Error(err)
				return
			}
			written.Store(int64(off + 4096))
			time.Sleep(20 * time.Microsecond)
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for ctx.Err() == nil {
			if err := e.j.RunOnce(ctx); err != nil && ctx.Err() == nil {
				t.Error(err)
				return
			}
		}
	}()

	var reads, truncs int
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	st := output.Default()
	var off int64
	for i := 0; ctx.Err() == nil; i++ {
		// Lag behind the writer so reads land in front of the janitor's hole.
		if i%8 == 0 {
			time.Sleep(time.Millisecond)
		}
		c, err := output.ReadChunk(st, f, off, -1, 8192)
		if err != nil {
			t.Fatal(err)
		}
		if c.Truncated {
			truncs++
			off = c.AvailableFrom
			continue
		}
		for i, b := range c.Data {
			if b != src[c.Offset+int64(i)] {
				t.Fatalf("byte at offset %d = %#x, want %#x", c.Offset+int64(i), b, src[c.Offset+int64(i)])
			}
		}
		reads += len(c.Data)
		off = c.Offset + int64(len(c.Data))
	}
	cancel()
	wg.Wait()
	t.Logf("read %d bytes of %d written, %d truncations", reads, written.Load(), truncs)
	if truncs == 0 {
		t.Log("warning: the reader was never truncated; the race was not exercised")
	}
	if reads == 0 {
		t.Fatal("reader made no progress")
	}
}
