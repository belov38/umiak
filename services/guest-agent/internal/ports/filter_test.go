package ports

import (
	"net/netip"
	"slices"
	"testing"
)

func TestFilterListenersByProcess(t *testing.T) {
	ls := []Listener{
		{Port: 135, Pid: 900, Process: "svchost.exe"},
		{Port: 445, Pid: 4, Process: "System"},
		{Port: 49664, Pid: 700, Process: "LSASS.EXE"},
		{Port: 8080, Pid: 1200, Process: "node.exe"},
		{Port: 3000, Pid: 1300}, // owner unknown
		{Port: 9000, Addr: netip.MustParseAddr("127.0.0.1"), Pid: 1400, Process: "svchost.exe.bak"},
	}
	got := filterListeners(ls, nil, []string{"system", "lsass.exe", "SVCHOST.exe", ""})
	var ports []uint16
	for _, l := range got {
		ports = append(ports, l.Port)
	}
	if want := []uint16{8080, 3000, 9000}; !slices.Equal(ports, want) {
		t.Fatalf("ports after filter = %v, want %v", ports, want)
	}
}

func TestFilterListenersByPort(t *testing.T) {
	ls := []Listener{{Port: 22}, {Port: 135}, {Port: 8080}}
	got := filterListeners(ls, []uint32{22, 135}, nil)
	if len(got) != 1 || got[0].Port != 8080 {
		t.Fatalf("got %v, want only 8080", got)
	}
}

func TestFilterListenersKeepsInput(t *testing.T) {
	ls := []Listener{{Port: 22}, {Port: 80}}
	_ = filterListeners(ls, []uint32{22}, nil)
	if ls[0].Port != 22 || ls[1].Port != 80 {
		t.Fatalf("input modified: %v", ls)
	}
	if got := filterListeners(nil, []uint32{22}, []string{"x"}); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}
