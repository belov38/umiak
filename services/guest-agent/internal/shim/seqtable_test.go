package shim

import (
	"fmt"
	"testing"
)

func TestSeqTableEvictsLeastRecentlyUsed(t *testing.T) {
	tab := newSeqTable(3)
	tab.set("a", 1)
	tab.set("b", 1)
	tab.set("c", 1)
	tab.set("a", 2) // a is now the most recent
	tab.set("d", 1) // evicts b
	if got := tab.last("b"); got != 0 {
		t.Errorf("b = %d, want evicted", got)
	}
	want := map[string]uint64{"a": 2, "c": 1, "d": 1}
	got := tab.snapshot()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("snapshot = %v, want %v", got, want)
	}
}

func TestSeqTableBounded(t *testing.T) {
	tab := newSeqTable(maxSessions)
	for i := range 3 * maxSessions {
		tab.set(fmt.Sprint(i), 1)
	}
	if n := len(tab.snapshot()); n != maxSessions {
		t.Errorf("sessions = %d, want %d", n, maxSessions)
	}
}
