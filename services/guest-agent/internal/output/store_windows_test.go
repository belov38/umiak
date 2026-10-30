//go:build windows

package output_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
)

// allocationSize returns the bytes NTFS has allocated for f.
func allocationSize(t *testing.T, f *os.File) int64 {
	t.Helper()
	// FILE_STANDARD_INFO.
	var info struct {
		AllocationSize int64
		EndOfFile      int64
		NumberOfLinks  uint32
		DeletePending  bool
		Directory      bool
	}
	err := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileStandardInfo,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err != nil {
		t.Fatal(err)
	}
	return info.AllocationSize
}

func TestPunchFrontAligns64K(t *testing.T) {
	st := output.Default()
	const size = 300 << 10
	f, data := writeFile(t, size)

	if err := st.PunchFront(f, 200<<10); err != nil {
		t.Fatal(err)
	}
	avail, err := st.AvailableFrom(f, size)
	if err != nil {
		t.Fatal(err)
	}
	if avail != 192<<10 {
		t.Fatalf("AvailableFrom = %d, want %d", avail, 192<<10)
	}
	got := make([]byte, size-avail)
	if _, err := f.ReadAt(got, avail); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data[avail:]) {
		t.Fatal("bytes after the hole changed")
	}
}

func TestAvailableFromUnpunched(t *testing.T) {
	st := output.Default()
	f, data := writeFile(t, 300<<10)
	avail, err := st.AvailableFrom(f, int64(len(data)))
	if err != nil || avail != 0 {
		t.Fatalf("AvailableFrom = %d, %v; want 0", avail, err)
	}
}

func TestPunchFrontFreesAllocation(t *testing.T) {
	st := output.Default()
	const size = 1 << 20
	f, _ := writeFile(t, size)
	if err := f.Sync(); err != nil {
		t.Fatal(err)
	}
	before := allocationSize(t, f)
	if err := st.PunchFront(f, size); err != nil {
		t.Fatal(err)
	}
	if after := allocationSize(t, f); after >= before {
		t.Fatalf("allocation %d -> %d, expected a decrease", before, after)
	}
	// The whole 64 KiB-aligned file is a hole.
	avail, err := st.AvailableFrom(f, size)
	if err != nil || avail != size {
		t.Fatalf("AvailableFrom = %d, %v; want %d", avail, err, size)
	}
}

func TestPunchFrontIsMonotonic(t *testing.T) {
	st := output.Default()
	f, data := writeFile(t, 512<<10)
	if err := st.PunchFront(f, 256<<10); err != nil {
		t.Fatal(err)
	}
	if err := st.PunchFront(f, 64<<10); err != nil {
		t.Fatal(err)
	}
	avail, err := st.AvailableFrom(f, int64(len(data)))
	if err != nil || avail != 256<<10 {
		t.Fatalf("AvailableFrom = %d, %v; want %d", avail, err, 256<<10)
	}
}

// TestPunchFrontPastEnd checks that an upTo beyond the file does not extend it.
func TestPunchFrontPastEnd(t *testing.T) {
	st := output.Default()
	const size = 150 << 10
	f, _ := writeFile(t, size)
	if err := st.PunchFront(f, 10<<20); err != nil {
		t.Fatal(err)
	}
	fi, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() != size {
		t.Fatalf("size = %d, want %d", fi.Size(), size)
	}
	avail, err := st.AvailableFrom(f, size)
	if err != nil || avail != 128<<10 {
		t.Fatalf("AvailableFrom = %d, %v; want %d", avail, err, 128<<10)
	}
}

// TestMarkSparseThenAppend mimics the shim: the file is marked sparse while
// empty, a writer appends through another handle, the janitor punches a
// read-write handle and reads through a read-only one.
func TestMarkSparseThenAppend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stdout")
	w, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	if err := output.MarkSparse(w); err != nil {
		t.Fatal(err)
	}
	data := randomData(400 << 10)
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}

	st := output.Default()
	rw, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rw.Close() }()
	if err := st.PunchFront(rw, 300<<10); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(data[:1000]); err != nil {
		t.Fatal(err)
	}

	r, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	size := int64(len(data) + 1000)
	avail, err := st.AvailableFrom(r, size)
	if err != nil || avail != 256<<10 {
		t.Fatalf("AvailableFrom = %d, %v; want %d", avail, err, 256<<10)
	}
	c, err := output.ReadChunk(st, r, avail, -1, 1<<10)
	if err != nil || c.Truncated || !bytes.Equal(c.Data, data[avail:avail+1<<10]) {
		t.Fatalf("chunk = %+v, %v", c, err)
	}
}

func TestMarkSparseEmptyFile(t *testing.T) {
	f, _ := writeFile(t, 0)
	if err := output.MarkSparse(f); err != nil {
		t.Fatal(err)
	}
	if avail, err := output.Default().AvailableFrom(f, 0); err != nil || avail != 0 {
		t.Fatalf("AvailableFrom = %d, %v; want 0", avail, err)
	}
}

func TestStatfs(t *testing.T) {
	total, free, err := output.DefaultStatfs(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if total == 0 || free == 0 || free > total {
		t.Fatalf("total = %d, free = %d", total, free)
	}
}

func TestStatfsMissingPath(t *testing.T) {
	if _, _, err := output.DefaultStatfs(filepath.Join(t.TempDir(), "nope", "x")); err == nil {
		t.Fatal("expected an error for a missing path")
	}
}
