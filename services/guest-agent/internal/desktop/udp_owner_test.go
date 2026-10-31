package desktop

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func fakeUDPTable(v6 bool, pids ...uint32) []byte {
	row, pidAt := udp4OwnerRow, 8
	if v6 {
		row, pidAt = udp6OwnerRow, 24
	}
	b := make([]byte, 4+len(pids)*row)
	binary.LittleEndian.PutUint32(b, uint32(len(pids)))
	for i, pid := range pids {
		binary.LittleEndian.PutUint32(b[4+i*row+pidAt:], pid)
	}
	return b
}

func TestUDPOwnedByCountsOnlyStreamerEndpoints(t *testing.T) {
	pids := map[uint32]bool{40: true}
	for _, v6 := range []bool{false, true} {
		got, e := udpOwnedBy(fakeUDPTable(v6, 4, 40, 1200, 40), v6, pids)
		if e != nil || got != 2 {
			t.Fatalf("v6=%v: %d %v", v6, got, e)
		}
		if _, e := udpOwnedBy(fakeUDPTable(v6, 40)[:10], v6, pids); e == nil {
			t.Fatalf("v6=%v: truncated table accepted", v6)
		}
	}
	if _, e := udpOwnedBy(nil, false, pids); e == nil {
		t.Fatal("empty buffer accepted")
	}
}

func TestStreamerSocketsWinOverUnbalancedSunshineLog(t *testing.T) {
	for _, sockets := range []uint32{0, 3} {
		dir := t.TempDir()
		if e := os.WriteFile(filepath.Join(dir, "sunshine.log"), []byte("Info: CLIENT CONNECTED\n"), 0600); e != nil {
			t.Fatal(e)
		}
		host := &FileHost{SunDir: dir, StreamSockets: func(context.Context) (uint32, error) { return sockets, nil }}
		want := min(sockets, 1)
		if got, e := host.Viewers(t.Context()); e != nil || got != want {
			t.Fatalf("sockets=%d: viewers=%d, want %d, error %v", sockets, got, want, e)
		}
	}
	// A failed socket sample falls back to the conservative lifecycle log.
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "sunshine.log"), []byte("Info: CLIENT CONNECTED\n"), 0600); e != nil {
		t.Fatal(e)
	}
	host := &FileHost{SunDir: dir, StreamSockets: func(context.Context) (uint32, error) { return 0, errors.New("no table") }}
	if got, e := host.Viewers(t.Context()); e != nil || got != 1 {
		t.Fatalf("fallback: %d %v", got, e)
	}
}
