package ports

import (
	"net"
	"os"
	"strings"
	"testing"
)

func listenTCP(t *testing.T, addr string) net.Listener {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), "tcp", addr)
	if err != nil {
		t.Skipf("cannot listen on %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return ln
}

func TestScanSeesOwnListener(t *testing.T) {
	ln := listenTCP(t, "127.0.0.1:0")
	port := uint16(ln.Addr().(*net.TCPAddr).Port)

	ls, err := defaultSource().listeners()
	if err != nil {
		t.Fatal(err)
	}
	var found *Listener
	for i := range ls {
		if ls[i].Port == port {
			found = &ls[i]
		}
	}
	if found == nil {
		t.Fatalf("port %d not among %d listeners", port, len(ls))
	}
	if found.Addr.String() != "127.0.0.1" {
		t.Errorf("addr = %s, want 127.0.0.1", found.Addr)
	}
	if int(found.Pid) != os.Getpid() {
		t.Errorf("pid = %d, want %d", found.Pid, os.Getpid())
	}
	exe, _ := os.Executable()
	if want := exe[strings.LastIndexByte(exe, '\\')+1:]; !strings.EqualFold(found.Process, want) {
		t.Errorf("process = %q, want %q", found.Process, want)
	}
	if found.User == "" {
		t.Error("user is empty")
	}
}

func TestScanSeesOwnIPv6Listener(t *testing.T) {
	ln := listenTCP(t, "[::1]:0")
	port := uint16(ln.Addr().(*net.TCPAddr).Port)

	ls, err := defaultSource().listeners()
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range ls {
		if l.Port == port {
			if l.Addr.String() != "::1" || int(l.Pid) != os.Getpid() {
				t.Fatalf("listener = %+v, want ::1 pid %d", l, os.Getpid())
			}
			return
		}
	}
	t.Fatalf("port %d not among %d listeners", port, len(ls))
}

func TestScannerListWindows(t *testing.T) {
	ln := listenTCP(t, "127.0.0.1:0")
	port := uint32(ln.Addr().(*net.TCPAddr).Port)

	exe, _ := os.Executable()
	name := exe[strings.LastIndexByte(exe, '\\')+1:]
	s := NewScanner(Options{})
	var seen bool
	for _, p := range s.List() {
		if p.Port == port {
			seen = true
			if int(p.Pid) != os.Getpid() {
				t.Errorf("pid = %d, want %d", p.Pid, os.Getpid())
			}
		}
	}
	if !seen {
		t.Fatalf("port %d not reported", port)
	}
	s = NewScanner(Options{ExcludeProcesses: []string{strings.ToUpper(name)}})
	for _, p := range s.List() {
		if p.Port == port {
			t.Fatalf("port %d reported despite process exclusion", port)
		}
	}
}
