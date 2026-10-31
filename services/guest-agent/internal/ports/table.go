package ports

import (
	"encoding/binary"
	"fmt"
	"net/netip"
)

// MIB_TCP_STATE_LISTEN in the rows of GetExtendedTcpTable.
const tcpStateListen = 2

// Row sizes of MIB_TCPROW_OWNER_PID and MIB_TCP6ROW_OWNER_PID.
const (
	tcpRow4Size = 24
	tcpRow6Size = 56
)

// parseTCPTable decodes a MIB_TCPTABLE_OWNER_PID (v6 false) or
// MIB_TCP6TABLE_OWNER_PID (v6 true) buffer, little-endian as on Windows, and
// returns the rows in LISTEN state. Ports are in network byte order in the
// low 16 bits of their DWORD; IPv4-mapped addresses are unmapped.
func parseTCPTable(b []byte, v6 bool) ([]Listener, error) {
	if len(b) < 4 {
		return nil, fmt.Errorf("ports: tcp table: %d bytes, no entry count", len(b))
	}
	n := uint64(binary.LittleEndian.Uint32(b))
	size := uint64(tcpRow4Size)
	if v6 {
		size = tcpRow6Size
	}
	if uint64(len(b)-4) < n*size {
		return nil, fmt.Errorf("ports: tcp table: %d entries need %d bytes, have %d", n, 4+n*size, len(b))
	}
	out := make([]Listener, 0, n)
	rows := b[4:]
	for range n {
		row := rows[:size]
		rows = rows[size:]
		var (
			state, pid uint32
			addr       netip.Addr
			port       uint16
		)
		if v6 {
			state = binary.LittleEndian.Uint32(row[48:])
			pid = binary.LittleEndian.Uint32(row[52:])
			addr = netip.AddrFrom16([16]byte(row[0:16])).Unmap()
			port = binary.BigEndian.Uint16(row[20:])
		} else {
			state = binary.LittleEndian.Uint32(row[0:])
			pid = binary.LittleEndian.Uint32(row[20:])
			addr = netip.AddrFrom4([4]byte(row[4:8]))
			port = binary.BigEndian.Uint16(row[8:])
		}
		if state != tcpStateListen {
			continue
		}
		out = append(out, Listener{Addr: addr, Port: port, Pid: pid})
	}
	return out, nil
}
