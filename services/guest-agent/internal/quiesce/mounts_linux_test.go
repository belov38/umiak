//go:build linux

package quiesce

import (
	"errors"
	"syscall"
	"testing"
)

// TestSysFreezerMounts reads the real mountinfo: whatever it lists must be
// freezable, one per source, deepest first.
func TestSysFreezerMounts(t *testing.T) {
	mounts, err := NewFreezer().Mounts()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for i, m := range mounts {
		if !freezableFS[m.FSType] {
			t.Errorf("mount %+v has a type that is not freezable", m)
		}
		if seen[m.Source] {
			t.Errorf("source %s listed twice", m.Source)
		}
		seen[m.Source] = true
		if i > 0 && depth(m.Path) > depth(mounts[i-1].Path) {
			t.Errorf("%s comes after the shallower %s", m.Path, mounts[i-1].Path)
		}
	}
	t.Logf("mounts: %+v", mounts)
}

// TestSysFreezerThawNotFrozen: FITHAW of a path that is not frozen fails
// with EINVAL as root, EPERM otherwise; either way it never freezes.
func TestSysFreezerThawNotFrozen(t *testing.T) {
	err := NewFreezer().Thaw(t.TempDir())
	if err == nil {
		t.Fatal("FITHAW of an unfrozen filesystem succeeded")
	}
	if !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.EPERM) && !errors.Is(err, syscall.ENOTTY) && !errors.Is(err, syscall.EOPNOTSUPP) {
		t.Errorf("FITHAW = %v", err)
	}
}
