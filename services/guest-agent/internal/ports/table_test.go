package ports

import (
	"encoding/binary"
	"net/netip"
	"slices"
	"testing"
)

// tcpRow4 encodes a MIB_TCPROW_OWNER_PID. addr bytes are in network order and
// the port is network order in the low 16 bits of its DWORD.
func tcpRow4(state uint32, addr [4]byte, port uint16, pid uint32) []byte {
	b := make([]byte, 24)
	binary.LittleEndian.PutUint32(b[0:], state)
	copy(b[4:], addr[:])
	b[8], b[9] = byte(port>>8), byte(port)
	binary.LittleEndian.PutUint32(b[20:], pid)
	return b
}

// tcpRow6 encodes a MIB_TCP6ROW_OWNER_PID.
func tcpRow6(state uint32, addr [16]byte, scope uint32, port uint16, pid uint32) []byte {
	b := make([]byte, 56)
	copy(b[0:], addr[:])
	binary.LittleEndian.PutUint32(b[16:], scope)
	b[20], b[21] = byte(port>>8), byte(port)
	binary.LittleEndian.PutUint32(b[48:], state)
	binary.LittleEndian.PutUint32(b[52:], pid)
	return b
}

func tcpTable(rows ...[]byte) []byte {
	b := binary.LittleEndian.AppendUint32(nil, uint32(len(rows)))
	for _, r := range rows {
		b = append(b, r...)
	}
	return b
}

func TestParseTCPTable4(t *testing.T) {
	tbl := tcpTable(
		tcpRow4(tcpStateListen, [4]byte{127, 0, 0, 1}, 8080, 1200),
		tcpRow4(tcpStateListen, [4]byte{0, 0, 0, 0}, 135, 900),
		tcpRow4(5, [4]byte{10, 0, 0, 5}, 50000, 77), // ESTABLISHED
		tcpRow4(tcpStateListen, [4]byte{10, 0, 0, 5}, 0xC350, 4),
	)
	got, err := parseTCPTable(tbl, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []Listener{
		{Addr: netip.MustParseAddr("127.0.0.1"), Port: 8080, Pid: 1200},
		{Addr: netip.MustParseAddr("0.0.0.0"), Port: 135, Pid: 900},
		{Addr: netip.MustParseAddr("10.0.0.5"), Port: 50000, Pid: 4},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseTCPTable6(t *testing.T) {
	loop := netip.IPv6Loopback().As16()
	mapped := netip.MustParseAddr("::ffff:10.0.0.5").As16()
	tbl := tcpTable(
		tcpRow6(tcpStateListen, loop, 0, 8080, 1200),
		tcpRow6(tcpStateListen, [16]byte{}, 0, 22, 800),
		tcpRow6(tcpStateListen, mapped, 0, 81, 5),
		tcpRow6(1, loop, 0, 9, 6), // CLOSED
	)
	got, err := parseTCPTable(tbl, true)
	if err != nil {
		t.Fatal(err)
	}
	want := []Listener{
		{Addr: netip.IPv6Loopback(), Port: 8080, Pid: 1200},
		{Addr: netip.IPv6Unspecified(), Port: 22, Pid: 800},
		{Addr: netip.MustParseAddr("10.0.0.5"), Port: 81, Pid: 5},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseTCPTableShort(t *testing.T) {
	if got, err := parseTCPTable(tcpTable(), false); err != nil || len(got) != 0 {
		t.Fatalf("empty table: %v, %v", got, err)
	}
	full := tcpTable(tcpRow4(tcpStateListen, [4]byte{1, 2, 3, 4}, 80, 1))
	if _, err := parseTCPTable(full[:len(full)-1], false); err == nil {
		t.Fatal("expected error for truncated table")
	}
	if _, err := parseTCPTable([]byte{1, 0}, false); err == nil {
		t.Fatal("expected error for missing count")
	}
	// A count larger than the buffer must not allocate or read past it.
	huge := binary.LittleEndian.AppendUint32(nil, 1<<30)
	if _, err := parseTCPTable(huge, true); err == nil {
		t.Fatal("expected error for oversized count")
	}
}
