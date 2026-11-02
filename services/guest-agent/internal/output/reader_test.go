package output_test

import (
	"bytes"
	"os"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/output"
)

func TestReadChunkTruncated(t *testing.T) {
	st := output.Default()
	f, data := writeFile(t, 1<<20)
	if err := st.PunchFront(f, 300_000); err != nil {
		t.Fatal(err)
	}

	c, err := output.ReadChunk(st, f, 0, -1, 65536)
	if err != nil {
		t.Fatal(err)
	}
	from := alignedDown(300_000)
	if !c.Truncated || c.AvailableFrom != from || c.Offset != from || len(c.Data) != 0 {
		t.Fatalf("chunk = %+v", c)
	}

	// Continuing from available_from returns the original bytes.
	c, err = output.ReadChunk(st, f, c.AvailableFrom, -1, 65536)
	if err != nil {
		t.Fatal(err)
	}
	if c.Truncated || c.Offset != from || !bytes.Equal(c.Data, data[from:from+65536]) {
		t.Fatalf("chunk = truncated %v offset %d len %d", c.Truncated, c.Offset, len(c.Data))
	}
}

// shiftingStore reports a different AvailableFrom on each call, like a
// janitor punching a hole between the two checks of ReadChunk.
type shiftingStore struct {
	values []int64
	calls  int
}

func (s *shiftingStore) AvailableFrom(*os.File, int64) (int64, error) {
	v := s.values[min(s.calls, len(s.values)-1)]
	s.calls++
	return v, nil
}

func (s *shiftingStore) PunchFront(*os.File, int64) error { return nil }

func TestReaderRecheckAfterPunch(t *testing.T) {
	f, _ := writeFile(t, 200_000)
	st := &shiftingStore{values: []int64{0, 4096}}

	c, err := output.ReadChunk(st, f, 0, -1, 65536)
	if err != nil {
		t.Fatal(err)
	}
	if !c.Truncated || c.AvailableFrom != 4096 || c.Offset != 4096 || len(c.Data) != 0 {
		t.Fatalf("chunk = %+v", c)
	}
	if st.calls != 2 {
		t.Fatalf("AvailableFrom called %d times, want 2", st.calls)
	}
}

func TestReaderRecheckKeepsDataWhenHoleBehindOffset(t *testing.T) {
	f, data := writeFile(t, 200_000)
	st := &shiftingStore{values: []int64{0, 0}}
	c, err := output.ReadChunk(st, f, 10, -1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if c.Truncated || c.Offset != 10 || !bytes.Equal(c.Data, data[10:110]) {
		t.Fatalf("chunk = %+v", c)
	}
}

func TestReadChunkStopsAtLimit(t *testing.T) {
	st := output.Default()
	f, data := writeFile(t, 100_000)

	tests := []struct {
		name      string
		off       int64
		limit     int64
		max       int
		wantStart int64
		wantEnd   int64
	}{
		{"limit before max", 1000, 1500, 65536, 1000, 1500},
		{"max before limit", 0, 90_000, 4096, 0, 4096},
		{"no limit stops at size", 99_000, -1, 65536, 99_000, 100_000},
		{"limit past size stops at size", 99_000, 500_000, 65536, 99_000, 100_000},
		{"at limit", 1500, 1500, 65536, 1500, 1500},
		{"at size", 100_000, -1, 65536, 100_000, 100_000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := output.ReadChunk(st, f, tt.off, tt.limit, tt.max)
			if err != nil {
				t.Fatal(err)
			}
			if c.Truncated || c.Offset != tt.off || !bytes.Equal(c.Data, data[tt.wantStart:tt.wantEnd]) {
				t.Fatalf("chunk = truncated %v offset %d len %d, want %d bytes", c.Truncated, c.Offset, len(c.Data), tt.wantEnd-tt.wantStart)
			}
		})
	}
}
