package output

import (
	"errors"
	"io"
	"os"
)

// DefaultMaxChunk is the largest chunk Attach reads at once (spec section 10).
const DefaultMaxChunk = 64 << 10

// Chunk is one piece of a stream read by ReadChunk.
type Chunk struct {
	// Offset is the stream offset of Data. When Truncated is set it is the
	// offset the caller should continue reading from (AvailableFrom).
	Offset int64
	// Data is the bytes read; empty when Truncated is set or nothing new is
	// available.
	Data []byte
	// Truncated reports that data before AvailableFrom was evicted and the
	// requested offset cannot be served. Data is empty; the caller reports
	// the gap and reads again from AvailableFrom.
	Truncated bool
	// AvailableFrom is the first offset that still holds data.
	AvailableFrom int64
}

// ReadChunk reads up to maxLen bytes of f at off, not past limit (the stream end
// of an exited command, or -1 for no limit). It never returns evicted bytes:
// if off is before the first available offset, or the janitor evicts the
// range while it is being read, the result is a Truncated chunk without data.
// f is read positionally and its file offset is not used for reading.
func ReadChunk(st Store, f *os.File, off, limit int64, maxLen int) (Chunk, error) {
	if maxLen <= 0 {
		maxLen = DefaultMaxChunk
	}
	size, err := fileSize(f)
	if err != nil {
		return Chunk{}, err
	}
	avail, err := st.AvailableFrom(f, size)
	if err != nil {
		return Chunk{}, err
	}
	if off < avail {
		return Chunk{Offset: avail, Truncated: true, AvailableFrom: avail}, nil
	}

	want := int64(maxLen)
	if limit >= 0 {
		want = min(want, limit-off)
	}
	want = min(want, size-off)
	if want <= 0 {
		return Chunk{Offset: off, AvailableFrom: avail}, nil
	}

	buf := make([]byte, want)
	n, err := f.ReadAt(buf, off)
	if err != nil && n == 0 {
		if errors.Is(err, io.EOF) {
			return Chunk{Offset: off, AvailableFrom: avail}, nil
		}
		return Chunk{}, err
	}
	buf = buf[:n]

	// The janitor may have punched the range while it was read. Holes only
	// move forward, so one re-check after the read is enough.
	size, err = fileSize(f)
	if err != nil {
		return Chunk{}, err
	}
	after, err := st.AvailableFrom(f, size)
	if err != nil {
		return Chunk{}, err
	}
	if after > off {
		return Chunk{Offset: after, Truncated: true, AvailableFrom: after}, nil
	}
	return Chunk{Offset: off, Data: buf, AvailableFrom: after}, nil
}

func fileSize(f *os.File) (int64, error) {
	fi, err := f.Stat()
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}
