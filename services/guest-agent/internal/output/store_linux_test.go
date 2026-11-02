//go:build linux

package output_test

import (
	"syscall"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/output"
)

// TestPunchFrontFreesBlocks checks that the real sparse store releases disk
// space, and that a fully punched file reports available_from = size
// (SEEK_DATA fails with ENXIO).
func TestPunchFrontFreesBlocks(t *testing.T) {
	st := output.Default()
	const size = 1 << 20
	f, _ := writeFile(t, size)
	if err := f.Sync(); err != nil {
		t.Fatal(err)
	}
	blocks := func() int64 {
		var s syscall.Stat_t
		if err := syscall.Fstat(int(f.Fd()), &s); err != nil {
			t.Fatal(err)
		}
		return s.Blocks * 512
	}
	before := blocks()
	if err := st.PunchFront(f, size); err != nil {
		t.Skipf("filesystem does not support hole punching: %v", err)
	}
	if after := blocks(); after >= before {
		t.Fatalf("allocated bytes %d -> %d, expected a decrease", before, after)
	}
	avail, err := st.AvailableFrom(f, size)
	if err != nil || avail != size {
		t.Fatalf("AvailableFrom = %d, %v; want %d", avail, err, size)
	}
}
