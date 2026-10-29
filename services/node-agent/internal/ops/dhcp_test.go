package ops

import (
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// seqFS serves successive contents for some paths, like a file that dnsmasq rewrites in place
// (truncate, then write) between two reads. The last content repeats.
type seqFS struct {
	base  fstest.MapFS
	seq   map[string][]string
	reads map[string]int
}

func (s *seqFS) next(name string) ([]byte, bool) {
	q, ok := s.seq[name]
	if !ok {
		return nil, false
	}
	i := min(s.reads[name], len(q)-1)
	s.reads[name]++
	return []byte(q[i]), true
}

func (s *seqFS) Open(name string) (fs.File, error) {
	if b, ok := s.next(name); ok {
		return fstest.MapFS{name: {Data: b}}.Open(name)
	}
	return s.base.Open(name)
}

func (s *seqFS) ReadFile(name string) ([]byte, error) {
	if b, ok := s.next(name); ok {
		return b, nil
	}
	return s.base.ReadFile(name)
}

const leaseFile = "var/lib/misc/dnsmasq.sbx.leases"

func seqHarness(seq map[string][]string, base fstest.MapFS) (*harness, *seqFS) {
	h := newHarness(nil)
	if base == nil {
		base = fstest.MapFS{}
	}
	s := &seqFS{base: base, seq: seq, reads: map[string]int{}}
	h.srv.Host.FS = s
	h.srv.Host.Sleep = func(time.Duration) {}
	return h, s
}

func TestDHCPLeasesReadsAroundAnInPlaceRewrite(t *testing.T) {
	for _, first := range []string{"", "1793300000 02:01:00:00:01:f4 10.88"} {
		h, _ := seqHarness(map[string][]string{leaseFile: {first, leases}}, nil)
		m := resultMap(t, h.call(t, "dhcp.leases", nil))
		if l := m["leases"].([]any); len(l) != 2 {
			t.Errorf("first read %q: leases = %v", first, l)
		}
	}
}

func TestDHCPReleaseSurvivesAnEmptyLeaseRead(t *testing.T) {
	h, _ := seqHarness(map[string][]string{leaseFile: {"", leases}}, nil)
	resultMap(t, h.call(t, "dhcp.release", map[string]any{"mac": "02:01:00:00:01:F4"}))
	if len(h.run.calls) == 0 || strings.Join(h.run.calls[0], " ") != "dhcp_release sbx0 10.88.0.100 02:01:00:00:01:f4" {
		t.Errorf("calls = %v", h.run.calls)
	}
}

func TestDHCPReleaseSendsReleaseForTheEthersIP(t *testing.T) {
	h := newHarness(fstest.MapFS{
		leaseFile:                  {Data: []byte("")},
		"etc/dnsmasq.d/sbx/ethers": {Data: []byte(ethers)},
	})
	files := &fakeFiles{files: map[string][]byte{"/etc/dnsmasq.d/sbx/ethers": []byte(ethers)}}
	h.srv.Host.Replace = files.replace
	m := resultMap(t, h.call(t, "dhcp.release", map[string]any{"mac": "02:01:00:00:01:F4"}))
	if m["released"] != true || len(h.run.calls) == 0 || strings.Join(h.run.calls[0], " ") != "dhcp_release sbx0 10.88.0.101 02:01:00:00:01:f4" {
		t.Errorf("result %v, calls = %v", m, h.run.calls)
	}
}

func TestDHCPReleaseFailsOnAFileThatNeverSettles(t *testing.T) {
	var q []string
	for i := range 50 {
		q = append(q, strings.Repeat("x", i)+"\n")
	}
	h, _ := seqHarness(map[string][]string{leaseFile: q}, nil)
	if r := h.call(t, "dhcp.leases", nil); r.OK {
		t.Errorf("unstable lease file accepted: %+v", r)
	}
}
