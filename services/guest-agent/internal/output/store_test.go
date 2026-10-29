package output_test

import (
	"bytes"
	"math/rand/v2"
	"os"
	"path/filepath"
	"testing"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
)

// writeFile creates a file of n pseudo-random non-zero bytes and opens it
// read-write.
func writeFile(t *testing.T, n int) (*os.File, []byte) {
	t.Helper()
	data := randomData(n)
	path := filepath.Join(t.TempDir(), "stdout")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	return f, data
}

// randomData returns n pseudo-random non-zero bytes.
func randomData(n int) []byte {
	data := make([]byte, n)
	rng := rand.New(rand.NewPCG(1, 2))
	for i := range data {
		data[i] = byte(1 + rng.IntN(255))
	}
	return data
}

func TestPunchFrontKeepsOffsets(t *testing.T) {
	st := output.Default()
	f, data := writeFile(t, 1<<20)

	if err := st.PunchFront(f, 300_000); err != nil {
		t.Fatal(err)
	}
	size := int64(len(data))
	avail, err := st.AvailableFrom(f, size)
	if err != nil {
		t.Fatal(err)
	}
	if avail != 299_008 {
		t.Fatalf("AvailableFrom = %d, want 299008", avail)
	}
	fi, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() != size {
		t.Fatalf("size = %d, want %d", fi.Size(), size)
	}
	got := make([]byte, size-avail)
	if _, err := f.ReadAt(got, avail); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data[avail:]) {
		t.Fatal("bytes after the hole changed")
	}

	// Evicting less than already evicted does nothing.
	if err := st.PunchFront(f, 100_000); err != nil {
		t.Fatal(err)
	}
	if again, _ := st.AvailableFrom(f, size); again != avail {
		t.Fatalf("AvailableFrom after smaller punch = %d, want %d", again, avail)
	}
}

func TestAvailableFromFreshFile(t *testing.T) {
	st := output.Default()
	f, data := writeFile(t, 10_000)
	avail, err := st.AvailableFrom(f, int64(len(data)))
	if err != nil || avail != 0 {
		t.Fatalf("AvailableFrom = %d, %v; want 0", avail, err)
	}
}

func TestAvailableFromEmptyFile(t *testing.T) {
	st := output.Default()
	f, _ := writeFile(t, 0)
	avail, err := st.AvailableFrom(f, 0)
	if err != nil || avail != 0 {
		t.Fatalf("AvailableFrom = %d, %v; want 0", avail, err)
	}
}

func TestPunchFrontBelowBlockIsNoop(t *testing.T) {
	st := output.Default()
	f, data := writeFile(t, 10_000)
	if err := st.PunchFront(f, 4095); err != nil {
		t.Fatal(err)
	}
	if avail, _ := st.AvailableFrom(f, int64(len(data))); avail != 0 {
		t.Fatalf("AvailableFrom = %d, want 0", avail)
	}
}
