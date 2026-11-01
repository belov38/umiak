package quiesce

import (
	"os"
	"testing"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

func TestLeaseOnDiskAndDrop(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	if lease, err := LeaseOnDisk(l); err != nil || lease != nil {
		t.Fatalf("no lease: %v, %v", lease, err)
	}
	if err := os.MkdirAll(l.RunDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.WriteJSONAtomic(claimPath(l), Lease{ID: "lease-1"}, 0o600); err != nil {
		t.Fatal(err)
	}
	lease, err := LeaseOnDisk(l)
	if err != nil || lease == nil || lease.ID != "lease-1" {
		t.Fatalf("claimed lease: %+v, %v", lease, err)
	}
	if err := fsutil.WriteJSONAtomic(l.QuiesceFile, Lease{ID: "lease-2"}, 0o600); err != nil {
		t.Fatal(err)
	}
	if lease, _ := LeaseOnDisk(l); lease == nil || lease.ID != "lease-2" {
		t.Errorf("lease file first: %+v", lease)
	}
	if err := DropLease(l); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{l.QuiesceFile, claimPath(l)} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s left: %v", p, err)
		}
	}
}
