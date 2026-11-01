package desktop

import (
	"encoding/binary"
	"errors"
)

// Row sizes of MIB_UDPROW_OWNER_PID and MIB_UDP6ROW_OWNER_PID (iphlpapi).
const (
	udp4OwnerRow = 12 // local addr, local port, owning pid
	udp6OwnerRow = 28 // local addr [16], scope id, local port, owning pid
)

// udpOwnedBy counts the UDP endpoints of a GetExtendedUdpTable(UDP_TABLE_OWNER_PID)
// buffer whose owning process is in pids.
func udpOwnedBy(table []byte, v6 bool, pids map[uint32]bool) (uint32, error) {
	if len(table) < 4 {
		return 0, errors.New("udp table: short buffer")
	}
	n := binary.LittleEndian.Uint32(table)
	row, pidAt := udp4OwnerRow, 8
	if v6 {
		row, pidAt = udp6OwnerRow, 24
	}
	if uint64(len(table)-4) < uint64(n)*uint64(row) {
		return 0, errors.New("udp table: truncated rows")
	}
	var count uint32
	for i := range int(n) {
		off := 4 + i*row
		if pids[binary.LittleEndian.Uint32(table[off+pidAt:])] {
			count++
		}
	}
	return count, nil
}
