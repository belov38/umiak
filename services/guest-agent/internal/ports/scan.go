// Package ports discovers listening TCP ports from procfs and dials CONNECT
// targets inside the VM (spec section 12).
package ports

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
)

// Scanner defaults.
const (
	defaultInterval = time.Second
	defaultDebounce = 2 * time.Second
)

// stateListen is the /proc/net/tcp state column of a LISTEN socket.
const stateListen = "0A"

// Listener is one LISTEN socket from /proc/net/tcp{,6}.
type Listener struct {
	Addr  netip.Addr
	Port  uint16
	Inode uint64
}

// ParseProcNetTCP parses the contents of /proc/net/tcp (v6 false) or
// /proc/net/tcp6 (v6 true) and returns the sockets in LISTEN state. Address
// words are in host byte order, as the kernel prints them.
func ParseProcNetTCP(r io.Reader, v6 bool) ([]Listener, error) {
	var out []Listener
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	first := true
	for sc.Scan() {
		if first {
			first = false // header line
			continue
		}
		fields := strings.Fields(sc.Text())
		if len(fields) == 0 {
			continue
		}
		if len(fields) < 10 {
			return nil, fmt.Errorf("ports: short line %q", sc.Text())
		}
		if fields[3] != stateListen {
			continue
		}
		addr, port, err := parseLocal(fields[1], v6)
		if err != nil {
			return nil, err
		}
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("ports: inode %q: %w", fields[9], err)
		}
		out = append(out, Listener{Addr: addr, Port: port, Inode: inode})
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("ports: read: %w", err)
	}
	return out, nil
}

// parseLocal parses "ADDRHEX:PORTHEX".
func parseLocal(s string, v6 bool) (netip.Addr, uint16, error) {
	host, portHex, ok := strings.Cut(s, ":")
	if !ok {
		return netip.Addr{}, 0, fmt.Errorf("ports: bad address %q", s)
	}
	p, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return netip.Addr{}, 0, fmt.Errorf("ports: bad port in %q: %w", s, err)
	}
	words := 1
	if v6 {
		words = 4
	}
	if len(host) != words*8 {
		return netip.Addr{}, 0, fmt.Errorf("ports: bad address length in %q", s)
	}
	var raw [16]byte
	for i := range words {
		w, err := strconv.ParseUint(host[i*8:i*8+8], 16, 32)
		if err != nil {
			return netip.Addr{}, 0, fmt.Errorf("ports: bad address %q: %w", s, err)
		}
		binary.NativeEndian.PutUint32(raw[i*4:], uint32(w))
	}
	if v6 {
		return netip.AddrFrom16(raw).Unmap(), uint16(p), nil
	}
	return netip.AddrFrom4([4]byte(raw[:4])), uint16(p), nil
}

// Options configures a Scanner.
type Options struct {
	// ProcDir is the procfs root; empty means /proc (Linux) or no scanning.
	ProcDir string
	// Exclude lists ports that are never reported.
	Exclude []uint16
	// Interval is the scan period; zero means 1 s.
	Interval time.Duration
	// Debounce is how long the port set must stay unchanged before
	// ports.changed is emitted; zero means 2 s.
	Debounce time.Duration
	// Emit receives ports.changed events.
	Emit events.Emitter
	// LocalAddrs lists the VM interface addresses; nil means InterfaceAddrs.
	LocalAddrs func() []netip.Addr
	// Log is optional.
	Log *slog.Logger
}

// Scanner reports the TCP ports listening on the VM.
type Scanner struct {
	opt Options
	log *slog.Logger

	mu        sync.Mutex
	scanned   bool
	key       string
	cur       []*agentv1.Port
	changedAt time.Time
	emitted   string
}

// NewScanner returns a Scanner; call Run to start the periodic scan.
func NewScanner(opt Options) *Scanner {
	if opt.ProcDir == "" {
		opt.ProcDir = defaultProcDir
	}
	if opt.Interval <= 0 {
		opt.Interval = defaultInterval
	}
	if opt.Debounce <= 0 {
		opt.Debounce = defaultDebounce
	}
	if opt.LocalAddrs == nil {
		opt.LocalAddrs = InterfaceAddrs
	}
	log := opt.Log
	if log == nil {
		log = slog.Default()
	}
	return &Scanner{opt: opt, log: log.With("component", "ports")}
}

// Run scans every Interval and emits ports.changed with the full list once
// the set has been stable for Debounce. It returns when ctx is done.
func (s *Scanner) Run(ctx context.Context) {
	if s.opt.ProcDir == "" {
		<-ctx.Done()
		return
	}
	t := time.NewTicker(s.opt.Interval)
	defer t.Stop()
	for {
		s.tick(time.Now())
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Scanner) tick(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.scanLocked(now); err != nil {
		s.log.Warn("port scan failed", "err", err)
		return
	}
	if s.key == s.emitted || now.Sub(s.changedAt) < s.opt.Debounce {
		return
	}
	s.emitted = s.key
	if s.opt.Emit != nil {
		s.opt.Emit.Emit(events.TypePortsChanged, &agentv1.PortsChanged{Ports: cloneList(s.cur)})
	}
}

// List returns the listening ports as of the latest scan, scanning first if
// none has run yet.
func (s *Scanner) List() []*agentv1.Port {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.scanned {
		if err := s.scanLocked(time.Now()); err != nil {
			s.log.Warn("port scan failed", "err", err)
		}
	}
	return cloneList(s.cur)
}

func cloneList(in []*agentv1.Port) []*agentv1.Port {
	out := make([]*agentv1.Port, len(in))
	for i, p := range in {
		out[i] = proto.Clone(p).(*agentv1.Port)
	}
	return out
}

// scanLocked reads procfs and, when the set of ports or their addresses
// changed, resolves owners and restarts the debounce window.
func (s *Scanner) scanLocked(now time.Time) error {
	listeners, err := s.readListeners()
	if err != nil {
		return err
	}
	byPort, key := s.group(listeners)
	if s.scanned && key == s.key {
		return nil
	}
	owners := s.resolveOwners(byPort)
	list := make([]*agentv1.Port, 0, len(byPort))
	for _, g := range byPort {
		p := &agentv1.Port{Port: uint32(g.port)}
		for _, a := range g.addrs {
			p.Addresses = append(p.Addresses, a.String())
		}
		if o, ok := owners[g.port]; ok {
			p.Pid, p.Process, p.User = int32(o.pid), o.process, o.user
		}
		list = append(list, p)
	}
	s.scanned = true
	s.key = key
	s.cur = list
	s.changedAt = now
	return nil
}

// readListeners reads both tcp tables; a missing tcp6 (IPv6 off) is fine.
func (s *Scanner) readListeners() ([]Listener, error) {
	var all []Listener
	var read int
	for _, t := range []struct {
		name string
		v6   bool
	}{{"tcp", false}, {"tcp6", true}} {
		data, err := os.ReadFile(filepath.Join(s.opt.ProcDir, "net", t.name))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("ports: %w", err)
		}
		ls, err := ParseProcNetTCP(bytes.NewReader(data), t.v6)
		if err != nil {
			return nil, err
		}
		all = append(all, ls...)
		read++
	}
	if read == 0 {
		return nil, fmt.Errorf("ports: no tcp table under %s/net", s.opt.ProcDir)
	}
	return all, nil
}

// portGroup is the reportable listeners of one port.
type portGroup struct {
	port   uint16
	addrs  []netip.Addr
	inodes []uint64
}

// group keeps the reportable listeners and groups them by port, sorted by
// port. The returned key identifies the set of ports and addresses.
func (s *Scanner) group(ls []Listener) ([]*portGroup, string) {
	local := make(map[netip.Addr]bool)
	for _, a := range s.opt.LocalAddrs() {
		local[a.Unmap().WithZone("")] = true
	}
	groups := make(map[uint16]*portGroup)
	for _, l := range ls {
		if slices.Contains(s.opt.Exclude, l.Port) {
			continue
		}
		if !l.Addr.IsUnspecified() && !l.Addr.IsLoopback() && !local[l.Addr] {
			continue
		}
		g := groups[l.Port]
		if g == nil {
			g = &portGroup{port: l.Port}
			groups[l.Port] = g
		}
		if !slices.Contains(g.addrs, l.Addr) {
			g.addrs = append(g.addrs, l.Addr)
		}
		g.inodes = append(g.inodes, l.Inode)
	}
	out := make([]*portGroup, 0, len(groups))
	for _, g := range groups {
		slices.SortFunc(g.addrs, netip.Addr.Compare)
		out = append(out, g)
	}
	slices.SortFunc(out, func(a, b *portGroup) int { return int(a.port) - int(b.port) })
	var sb strings.Builder
	for _, g := range out {
		sb.WriteString(strconv.Itoa(int(g.port)))
		for _, a := range g.addrs {
			sb.WriteByte(' ')
			sb.WriteString(a.String())
		}
		sb.WriteByte('\n')
	}
	return out, sb.String()
}
