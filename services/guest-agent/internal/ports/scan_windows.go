package ports

import (
	"errors"
	"fmt"
	"sync"

	"golang.org/x/sys/windows"

	"github.com/belov38/umiak/services/guest-agent/internal/winapi"
)

// defaultProcDir is empty on Windows: the socket table comes from
// GetExtendedTcpTable, not procfs.
const defaultProcDir = ""

// defaultSource reads listeners from the IPv4 and IPv6 TCP owner-pid tables.
func defaultSource() listenerSource { return &tcpTableSource{} }

// tcpTableSource lists LISTEN sockets with their owner. The owner lookup
// (image name, token user and account lookup) is cached per pid while the pid
// keeps listening, since the table is read every second.
type tcpTableSource struct {
	mu   sync.Mutex
	info map[uint32]winapi.ProcessInfo
}

func (s *tcpTableSource) listeners() ([]Listener, error) {
	var all []Listener
	for _, t := range []struct {
		family uint32
		v6     bool
	}{{winapi.AFInet, false}, {winapi.AFInet6, true}} {
		raw, err := winapi.ExtendedTCPListeners(t.family)
		if err != nil {
			// IPv6 can be unavailable; IPv4 must work.
			if t.v6 && errors.Is(err, windows.ERROR_NOT_SUPPORTED) {
				continue
			}
			return nil, fmt.Errorf("ports: %w", err)
		}
		ls, err := parseTCPTable(raw, t.v6)
		if err != nil {
			return nil, err
		}
		all = append(all, ls...)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	live := make(map[uint32]winapi.ProcessInfo)
	for i := range all {
		l := &all[i]
		if l.Pid == 0 {
			continue
		}
		info, ok := live[l.Pid]
		if !ok {
			if info, ok = s.info[l.Pid]; !ok {
				var err error
				if info, err = winapi.QueryProcess(l.Pid); err != nil {
					// Exited, or not openable; retried on the next scan.
					continue
				}
			}
			live[l.Pid] = info
		}
		l.Process, l.User = info.Name, info.User
	}
	s.info = live
	return all, nil
}

// owners reports the owners the table rows carried.
func (s *tcpTableSource) owners(groups []*portGroup) map[uint16]owner {
	return groupOwners(groups)
}
