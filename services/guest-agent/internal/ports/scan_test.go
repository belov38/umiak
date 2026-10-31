package ports

import (
	"context"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
)

const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

func tcpLine(sl int, local, state string, inode int) string {
	return "   " + strconv.Itoa(sl) + ": " + local + " 00000000:0000 " + state +
		" 00000000:00000000 00:00000000 00000000  1000        0 " + strconv.Itoa(inode) + " 1 0000000000000000 100 0 0 10 0\n"
}

func TestParseProcNetTCP(t *testing.T) {
	v4 := tcpHeader +
		tcpLine(0, "0100007F:1F90", "0A", 111) +
		tcpLine(1, "00000000:0050", "0A", 222) +
		tcpLine(2, "0100007F:A2B4", "01", 333) // ESTABLISHED
	got, err := ParseProcNetTCP(strings.NewReader(v4), false)
	if err != nil {
		t.Fatal(err)
	}
	want := []Listener{
		{Addr: netip.MustParseAddr("127.0.0.1"), Port: 8080, Inode: 111},
		{Addr: netip.MustParseAddr("0.0.0.0"), Port: 80, Inode: 222},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("v4: got %v, want %v", got, want)
	}

	v6 := tcpHeader +
		tcpLine(0, "00000000000000000000000001000000:1F90", "0A", 444) +
		tcpLine(1, "00000000000000000000000000000000:0016", "0A", 555) +
		tcpLine(2, "0000000000000000FFFF00000100007F:0050", "0A", 666) +
		tcpLine(3, "00000000000000000000000001000000:C350", "06", 777)
	got, err = ParseProcNetTCP(strings.NewReader(v6), true)
	if err != nil {
		t.Fatal(err)
	}
	want = []Listener{
		{Addr: netip.MustParseAddr("::1"), Port: 8080, Inode: 444},
		{Addr: netip.MustParseAddr("::"), Port: 22, Inode: 555},
		{Addr: netip.MustParseAddr("127.0.0.1"), Port: 80, Inode: 666},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("v6: got %v, want %v", got, want)
	}

	if _, err := ParseProcNetTCP(strings.NewReader(tcpHeader+"garbage\n   0: zz\n"), false); err == nil {
		t.Fatal("expected error for malformed line")
	}
}

// fakeProc builds a procfs tree under a temp dir.
type fakeProc struct {
	t   *testing.T
	dir string
}

func newFakeProc(t *testing.T) *fakeProc {
	t.Helper()
	f := &fakeProc{t: t, dir: t.TempDir()}
	if err := os.MkdirAll(filepath.Join(f.dir, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.setTables("", "")
	return f
}

// setTables atomically replaces net/tcp and net/tcp6 bodies (lines only).
func (f *fakeProc) setTables(v4, v6 string) {
	f.t.Helper()
	for name, body := range map[string]string{"tcp": v4, "tcp6": v6} {
		tmp := filepath.Join(f.dir, "net", name+".tmp")
		if err := os.WriteFile(tmp, []byte(tcpHeader+body), 0o644); err != nil {
			f.t.Fatal(err)
		}
		if err := os.Rename(tmp, filepath.Join(f.dir, "net", name)); err != nil {
			f.t.Fatal(err)
		}
	}
}

// addProcess adds /proc/<pid> holding the given socket inodes.
func (f *fakeProc) addProcess(pid int, comm string, uid int, inodes ...int) {
	f.t.Helper()
	dir := filepath.Join(f.dir, strconv.Itoa(pid))
	if err := os.MkdirAll(filepath.Join(dir, "fd"), 0o755); err != nil {
		f.t.Fatal(err)
	}
	must := func(err error) {
		f.t.Helper()
		if err != nil {
			f.t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "comm"), []byte(comm+"\n"), 0o644))
	u := strconv.Itoa(uid)
	must(os.WriteFile(filepath.Join(dir, "status"), []byte("Name:\t"+comm+"\nUid:\t"+u+"\t"+u+"\t"+u+"\t"+u+"\n"), 0o644))
	must(os.Symlink("/dev/null", filepath.Join(dir, "fd", "0")))
	for i, in := range inodes {
		must(os.Symlink("socket:["+strconv.Itoa(in)+"]", filepath.Join(dir, "fd", strconv.Itoa(i+3))))
	}
}

func portsOf(m interface{ GetPorts() []*agentv1.Port }) []uint32 {
	var out []uint32
	for _, p := range m.GetPorts() {
		out = append(out, p.GetPort())
	}
	return out
}

func TestScannerList(t *testing.T) {
	f := newFakeProc(t)
	f.setTables(
		tcpLine(0, "0100007F:1F90", "0A", 111)+ // 127.0.0.1:8080
			tcpLine(1, "0500000A:0050", "0A", 222)+ // 10.0.0.5:80, local iface
			tcpLine(2, "0900000A:0051", "0A", 223)+ // 10.0.0.9:81, not ours
			tcpLine(3, "00000000:0016", "0A", 224), // 0.0.0.0:22, excluded
		tcpLine(0, "00000000000000000000000001000000:1F90", "0A", 333), // [::1]:8080
	)
	f.addProcess(10, "other", 0, 111)
	f.addProcess(7, "myapp", 0, 333, 222)
	s := NewScanner(Options{
		ProcDir:    f.dir,
		Exclude:    []uint16{22},
		LocalAddrs: func() []netip.Addr { return []netip.Addr{netip.MustParseAddr("10.0.0.5")} },
	})
	got := s.List()
	if len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	// The procfs owner is a uid: Windows has no uid 0, so the name stays
	// numeric there.
	owner := "root"
	if runtime.GOOS == "windows" {
		owner = "0"
	}
	want8080 := &agentv1.Port{Port: 8080, Addresses: []string{"127.0.0.1", "::1"}, Pid: 7, Process: "myapp", User: owner}
	want80 := &agentv1.Port{Port: 80, Addresses: []string{"10.0.0.5"}, Pid: 7, Process: "myapp", User: owner}
	// Sorted by port: 80, 8080.
	if !proto.Equal(got[0], want80) || !proto.Equal(got[1], want8080) {
		t.Fatalf("got %v, want %v and %v", got, want80, want8080)
	}
}

func TestScannerDebounce(t *testing.T) {
	f := newFakeProc(t)
	rec := &events.Recorder{}
	s := NewScanner(Options{
		ProcDir:    f.dir,
		Exclude:    []uint16{22},
		Interval:   10 * time.Millisecond,
		Debounce:   300 * time.Millisecond,
		Emit:       rec,
		LocalAddrs: func() []netip.Addr { return nil },
	})
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	// First change, then a second one well within the debounce window.
	f.setTables(tcpLine(0, "0100007F:1F90", "0A", 111), "")
	time.Sleep(100 * time.Millisecond)
	f.setTables(
		tcpLine(0, "0100007F:1F90", "0A", 111)+tcpLine(1, "00000000:0050", "0A", 222)+tcpLine(2, "00000000:0016", "0A", 223),
		"",
	)

	deadline := time.Now().Add(5 * time.Second)
	for len(rec.Of(events.TypePortsChanged)) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no ports.changed event")
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(600 * time.Millisecond) // a late duplicate would show up here
	evs := rec.Of(events.TypePortsChanged)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	got := portsOf(evs[0].(*agentv1.PortsChanged))
	if !slices.Equal(got, []uint32{80, 8080}) {
		t.Fatalf("ports = %v, want [80 8080] (22 excluded)", got)
	}

	// A further change emits a second snapshot.
	f.setTables("", "")
	deadline = time.Now().Add(5 * time.Second)
	for len(rec.Of(events.TypePortsChanged)) < 2 {
		if time.Now().After(deadline) {
			t.Fatal("no second ports.changed event")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := portsOf(rec.Of(events.TypePortsChanged)[1].(*agentv1.PortsChanged)); len(got) != 0 {
		t.Fatalf("second snapshot = %v, want empty", got)
	}
}

func TestScannerMissingTables(t *testing.T) {
	s := NewScanner(Options{ProcDir: t.TempDir()})
	if got := s.List(); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

// fakeSource is a listenerSource that reports owners in the listeners, as
// the Windows source does.
type fakeSource struct{ ls []Listener }

func (f *fakeSource) listeners() ([]Listener, error)         { return f.ls, nil }
func (f *fakeSource) owners(g []*portGroup) map[uint16]owner { return groupOwners(g) }

func TestScannerSourceOwnersAndProcessExclude(t *testing.T) {
	lo := netip.MustParseAddr("127.0.0.1")
	src := &fakeSource{ls: []Listener{
		{Addr: lo, Port: 8080, Pid: 30, Process: "node.exe", User: "user"},
		{Addr: netip.IPv6Loopback(), Port: 8080, Pid: 20, Process: "node.exe", User: "user"},
		{Addr: netip.IPv6Unspecified(), Port: 135, Pid: 900, Process: "svchost.exe", User: "NETWORK SERVICE"},
		{Addr: lo, Port: 445, Pid: 4, Process: "System"},
		{Addr: lo, Port: 22, Pid: 800, Process: "sshd.exe"},
		{Addr: lo, Port: 5000},
	}}
	s := NewScanner(Options{
		source:           src,
		Exclude:          []uint16{22},
		ExcludeProcesses: []string{"System", "SVCHOST.EXE"},
		LocalAddrs:       func() []netip.Addr { return nil },
	})
	got := s.List()
	want := []*agentv1.Port{
		{Port: 5000, Addresses: []string{"127.0.0.1"}},
		{Port: 8080, Addresses: []string{"127.0.0.1", "::1"}, Pid: 20, Process: "node.exe", User: "user"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if !proto.Equal(got[i], want[i]) {
			t.Fatalf("port %d: got %v, want %v", i, got[i], want[i])
		}
	}
}
