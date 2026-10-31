package desktop

import (
	"context"
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetExtendedUDPTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedUdpTable")

const udpTableOwnerPID = 1

// processIDs returns the ids of running processes with the image name.
func processIDs(image string) (map[uint32]bool, error) {
	snap, e := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if e != nil {
		return nil, e
	}
	defer func() { _ = windows.CloseHandle(snap) }()
	pids := map[uint32]bool{}
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for e = windows.Process32First(snap, &entry); e == nil; e = windows.Process32Next(snap, &entry) {
		if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), image) {
			pids[entry.ProcessID] = true
		}
	}
	if !errors.Is(e, windows.ERROR_NO_MORE_FILES) {
		return nil, e
	}
	return pids, nil
}

// udpTable reads the UDP endpoint table with owning process ids for one family.
func udpTable(family uint32) ([]byte, error) {
	size := uint32(4096)
	for range 4 {
		buf := make([]byte, size)
		r, _, _ := procGetExtendedUDPTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, uintptr(family), udpTableOwnerPID, 0)
		switch windows.Errno(r) {
		case 0:
			return buf[:size], nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			continue
		default:
			return nil, windows.Errno(r)
		}
	}
	return nil, errors.New("udp table keeps growing")
}

// moonlightUDPSockets counts UDP endpoints owned by moonlight-web (web-server.exe).
func moonlightUDPSockets(context.Context) (uint32, error) {
	pids, e := processIDs("web-server.exe")
	if e != nil || len(pids) == 0 {
		return 0, e
	}
	var total uint32
	for _, f := range []struct {
		family uint32
		v6     bool
	}{{windows.AF_INET, false}, {windows.AF_INET6, true}} {
		table, e := udpTable(f.family)
		if e != nil {
			return 0, e
		}
		n, e := udpOwnedBy(table, f.v6, pids)
		if e != nil {
			return 0, e
		}
		total += n
	}
	return total, nil
}
