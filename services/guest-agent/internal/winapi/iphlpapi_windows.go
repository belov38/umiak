package winapi

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modiphlpapi = windows.NewLazySystemDLL("iphlpapi.dll")

	procGetExtendedTCPTable = modiphlpapi.NewProc("GetExtendedTcpTable")
)

// Address families and the table class of GetExtendedTcpTable.
const (
	AFInet  = 2  // AF_INET
	AFInet6 = 23 // AF_INET6

	tcpTableOwnerPIDListener = 3 // TCP_TABLE_OWNER_PID_LISTENER
)

// ExtendedTCPListeners returns the raw MIB_TCPTABLE_OWNER_PID (family
// AFInet) or MIB_TCP6TABLE_OWNER_PID (AFInet6) buffer of the LISTEN sockets.
// GetExtendedTcpTable returns its error code instead of setting the last
// error, and the table can grow between the size query and the read, so the
// call is retried with the size it reports.
func ExtendedTCPListeners(family uint32) ([]byte, error) {
	size := uint32(4096)
	for range 8 {
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTCPTable.Call(
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(unsafe.Pointer(&size)),
			0, // unsorted
			uintptr(family),
			tcpTableOwnerPIDListener,
			0,
		)
		switch e := windows.Errno(r); e {
		case 0:
			return buf[:size], nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			if size < 4 {
				size = 4096
			}
			continue
		default:
			return nil, fmt.Errorf("winapi: GetExtendedTcpTable(af %d): %w", family, e)
		}
	}
	return nil, errors.New("winapi: GetExtendedTcpTable: table size keeps changing")
}
