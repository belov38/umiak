package ops

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/belov38/boat-dev-clone/services/node-agent/internal/lvm"
)

type fakeLVM struct {
	lvs      []lvm.LV
	failName string
	created  []string
	removed  []string
}

func (f *fakeLVM) List(context.Context) ([]lvm.LV, error) { return slices.Clone(f.lvs), nil }

func (f *fakeLVM) CreateSnapshot(_ context.Context, s lvm.CreateSpec) error {
	if s.Name == f.failName {
		return errors.New("lvcreate failed")
	}
	f.created = append(f.created, s.Name)
	f.lvs = append(f.lvs, lvm.LV{Name: s.Name, Tags: s.Tags, Origin: s.Origin})
	return nil
}

func (f *fakeLVM) Remove(_ context.Context, name string) error {
	f.removed = append(f.removed, name)
	f.lvs = slices.DeleteFunc(f.lvs, func(l lvm.LV) bool { return l.Name == name })
	return nil
}

func (f *fakeLVM) AutoextendThreshold(context.Context) (int, error) { return 100, nil }

type fakeRun struct {
	calls [][]string
	out   map[string]string
}

func (r *fakeRun) run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, append([]string{name}, args...))
	return []byte(r.out[name]), nil
}

type harness struct {
	srv  *Server
	lvm  *fakeLVM
	run  *fakeRun
	logs []string
}

func newHarness(files fstest.MapFS) *harness {
	h := &harness{
		lvm: &fakeLVM{lvs: []lvm.LV{
			{Name: "data", Tags: []string{}, SizeBytes: 1000, DataPercent: 6.5, MetadataPercent: 0.7},
			{Name: "base-599-disk-0", Tags: []string{"sbx-tpl"}, PoolLV: "data"},
			{Name: "vm-108-disk-1", Tags: []string{}, PoolLV: "data"},
			{Name: "vm-500-disk-0", Tags: []string{"sbx", "sbx-vm-500"}, SizeBytes: 100, DataPercent: 50, PoolLV: "data"},
		}},
		run: &fakeRun{out: map[string]string{}},
	}
	if files == nil {
		files = fstest.MapFS{}
	}
	h.srv = &Server{
		Cfg: testConfig(),
		LVM: h.lvm,
		Host: Host{
			FS: files, Run: h.run.run, Now: func() time.Time { return time.Unix(1793300000, 0) },
			Replace: (&fakeFiles{files: map[string][]byte{}}).replace,
		},
		Log:     func(s string) { h.logs = append(h.logs, s) },
		Version: "test",
	}
	return h
}

func (h *harness) call(t *testing.T, op string, args any) Response {
	t.Helper()
	a, _ := json.Marshal(args)
	raw, _ := json.Marshal(map[string]any{"op": op, "args": json.RawMessage(a), "requestId": "r1"})
	return h.srv.Handle(context.Background(), raw)
}

func resultMap(t *testing.T, r Response) map[string]any {
	t.Helper()
	if !r.OK {
		t.Fatalf("not ok: %+v", r.Error)
	}
	b, _ := json.Marshal(r.Result)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestUnknownOpAndBadJSON(t *testing.T) {
	h := newHarness(nil)
	if r := h.call(t, "lv.destroyall", nil); r.OK || r.Error.Code != "bad_request" {
		t.Errorf("unknown op: %+v", r)
	}
	if r := h.srv.Handle(context.Background(), []byte("{nope")); r.OK || r.Error.Code != "bad_request" {
		t.Errorf("bad json: %+v", r)
	}
}

func TestVersionReturnsConfig(t *testing.T) {
	m := resultMap(t, newHarness(nil).call(t, "version", nil))
	if m["version"] != "test" || m["config"].(map[string]any)["vg"] != "pve" {
		t.Errorf("version = %v", m)
	}
}

func TestSnapshotBatchRollsBackOnFailure(t *testing.T) {
	h := newHarness(nil)
	h.lvm.failName = "vm-501-disk-0"
	r := h.call(t, "lv.snapshot", map[string]any{"items": []SnapshotItem{
		{Origin: "base-599-disk-0", Name: "vm-500-disk-1", Tags: []string{"sbx", "sbx-vm-500"}},
		{Origin: "base-599-disk-0", Name: "vm-501-disk-0", Tags: []string{"sbx", "sbx-vm-501"}},
	}})
	if r.OK || r.Error.Code != "exec_failed" {
		t.Fatalf("want exec_failed, got %+v", r)
	}
	if !slices.Equal(h.lvm.removed, []string{"vm-500-disk-1"}) {
		t.Errorf("rollback removed %v", h.lvm.removed)
	}
}

func TestSnapshotValidatesAllBeforeCreating(t *testing.T) {
	h := newHarness(nil)
	r := h.call(t, "lv.snapshot", map[string]any{"items": []SnapshotItem{
		{Origin: "base-599-disk-0", Name: "vm-500-disk-1", Tags: []string{"sbx", "sbx-vm-500"}},
		{Origin: "base-9000-disk-0", Name: "vm-501-disk-0", Tags: []string{"sbx", "sbx-vm-501"}},
	}})
	if r.OK || r.Error.Code != "forbidden" || len(h.lvm.created) != 0 {
		t.Errorf("got %+v, created %v", r, h.lvm.created)
	}
}

func TestSnapshotSuccess(t *testing.T) {
	h := newHarness(nil)
	m := resultMap(t, h.call(t, "lv.snapshot", map[string]any{"items": []SnapshotItem{
		{Origin: "vm-500-disk-0", Name: "sbx-snap-abc-scsi0", Tags: []string{"sbx", "sbx-snap-abc", "sbx-src-500"}, ActivationSkip: true},
	}}))
	if c := m["created"].([]any); len(c) != 1 || c[0] != "sbx-snap-abc-scsi0" {
		t.Errorf("created = %v", m["created"])
	}
}

func TestRemoveRefusesForeignLVsBeforeRemovingAnything(t *testing.T) {
	for _, foreign := range []string{"vm-108-disk-1", "base-599-disk-0", "data"} {
		h := newHarness(nil)
		r := h.call(t, "lv.remove", map[string]any{"names": []string{"vm-500-disk-0", foreign}})
		if r.OK || r.Error.Code != "forbidden" || len(h.lvm.removed) != 0 {
			t.Errorf("%s: got %+v, removed %v", foreign, r, h.lvm.removed)
		}
	}
}

func TestRemoveReportsMissing(t *testing.T) {
	h := newHarness(nil)
	m := resultMap(t, h.call(t, "lv.remove", map[string]any{"names": []string{"vm-500-disk-0", "vm-501-disk-0"}}))
	if len(m["removed"].([]any)) != 1 || m["missing"].([]any)[0] != "vm-501-disk-0" {
		t.Errorf("result = %v", m)
	}
}

func TestListFiltersByAllTags(t *testing.T) {
	h := newHarness(nil)
	m := resultMap(t, h.call(t, "lv.list", map[string]any{"tags": []string{"sbx", "sbx-vm-500"}}))
	if l := m["lvs"].([]any); len(l) != 1 {
		t.Errorf("lvs = %v", l)
	}
	m = resultMap(t, h.call(t, "lv.list", nil))
	if l := m["lvs"].([]any); len(l) != 4 {
		t.Errorf("unfiltered lvs = %d", len(l))
	}
}

func TestPoolUsage(t *testing.T) {
	m := resultMap(t, newHarness(nil).call(t, "pool.usage", nil))
	if m["dataPercent"] != 6.5 || m["metadataPercent"] != 0.7 || m["ourLvCount"] != 1.0 || m["ourLvUsedBytes"] != 50.0 || m["autoextendThreshold"] != 100.0 {
		t.Errorf("usage = %v", m)
	}
}

const leases = "1793300000 02:01:00:00:01:f4 10.88.0.100 sbx-500 01:02:01:00:00:01:f4\n1793300100 bc:24:11:00:00:01 10.88.0.101 * *\n"

func TestDHCPLeasesAndRelease(t *testing.T) {
	h := newHarness(fstest.MapFS{"var/lib/misc/dnsmasq.sbx.leases": {Data: []byte(leases)}})
	m := resultMap(t, h.call(t, "dhcp.leases", nil))
	l := m["leases"].([]any)
	if len(l) != 2 || l[0].(map[string]any)["ip"] != "10.88.0.100" || l[0].(map[string]any)["mac"] != "02:01:00:00:01:f4" {
		t.Fatalf("leases = %v", l)
	}
	m = resultMap(t, h.call(t, "dhcp.release", map[string]any{"mac": "02:01:00:00:01:F4"}))
	if m["released"] != true || strings.Join(h.run.calls[0], " ") != "dhcp_release sbx0 10.88.0.100 02:01:00:00:01:f4" {
		t.Errorf("release = %v, calls %v", m, h.run.calls)
	}
	if r := h.call(t, "dhcp.release", map[string]any{"mac": "BC:24:11:00:00:01"}); r.OK || r.Error.Code != "forbidden" {
		t.Errorf("foreign MAC release: %+v", r)
	}
}

func TestDHCPLeasesMissingFileIsEmpty(t *testing.T) {
	m := resultMap(t, newHarness(nil).call(t, "dhcp.leases", nil))
	if len(m["leases"].([]any)) != 0 {
		t.Errorf("leases = %v", m)
	}
}

func TestLogRedactsSearchString(t *testing.T) {
	h := newHarness(nil)
	h.run.out["journalctl"] = "line with SECRET-SERIAL inside\n"
	m := resultMap(t, h.call(t, "inventory", map[string]any{"sections": []string{"search"}, "search": "SECRET-SERIAL", "since": 1793290000}))
	if m["search"].(map[string]any)["journal"] != true {
		t.Errorf("search = %v", m["search"])
	}
	for _, l := range h.logs {
		if strings.Contains(l, "SECRET-SERIAL") {
			t.Errorf("log leaks search string: %s", l)
		}
	}
	h.call(t, "lv.list", map[string]any{"tags": []string{"sbx-vm-500"}})
	if last := h.logs[len(h.logs)-1]; !strings.Contains(last, "sbx-vm-500") || !strings.Contains(last, "r1") {
		t.Errorf("normal op args not logged: %s", last)
	}
}

type fakeFiles struct {
	files map[string][]byte
}

func (f *fakeFiles) replace(path string, edit func([]byte) ([]byte, error)) error {
	out, err := edit(f.files[path])
	if err != nil {
		return err
	}
	f.files[path] = out
	return nil
}

const ethers = "02:01:00:00:02:57,10.88.0.100\n02:01:00:00:01:f4,10.88.0.101\n"

func TestDHCPReleaseRemovesStaleEthersLine(t *testing.T) {
	h := newHarness(fstest.MapFS{
		"var/lib/misc/dnsmasq.sbx.leases": {Data: []byte(leases)},
		"etc/pve/sdn/mac-cache.json":      {Data: []byte(`{"macs":{"02:01:00:00:02:57":{"ip4":"10.88.0.100"}}}`)},
		"etc/dnsmasq.d/sbx/ethers":        {Data: []byte(ethers)},
	})
	files := &fakeFiles{files: map[string][]byte{"/etc/dnsmasq.d/sbx/ethers": []byte(ethers)}}
	h.srv.Host.Replace = files.replace
	m := resultMap(t, h.call(t, "dhcp.release", map[string]any{"mac": "02:01:00:00:01:F4"}))
	if m["released"] != true || m["ethersRemoved"] != true {
		t.Fatalf("result = %v", m)
	}
	if got := string(files.files["/etc/dnsmasq.d/sbx/ethers"]); got != "02:01:00:00:02:57,10.88.0.100\n" {
		t.Errorf("ethers = %q", got)
	}
	last := strings.Join(h.run.calls[len(h.run.calls)-1], " ")
	if last != "systemctl reload dnsmasq@sbx" {
		t.Errorf("last call = %q", last)
	}
}

func TestDHCPReleaseKeepsEthersWhileMACIsInIPAM(t *testing.T) {
	h := newHarness(fstest.MapFS{
		"etc/pve/sdn/mac-cache.json": {Data: []byte(`{"macs":{"02:01:00:00:01:f4":{"ip4":"10.88.0.101"}}}`)},
	})
	files := &fakeFiles{files: map[string][]byte{"/etc/dnsmasq.d/sbx/ethers": []byte(ethers)}}
	h.srv.Host.Replace = files.replace
	m := resultMap(t, h.call(t, "dhcp.release", map[string]any{"mac": "02:01:00:00:01:f4"}))
	if m["ethersRemoved"] != false || m["inMacCache"] != true {
		t.Errorf("result = %v", m)
	}
	if string(files.files["/etc/dnsmasq.d/sbx/ethers"]) != ethers {
		t.Error("ethers must not change while the MAC is still in the IPAM mac cache")
	}
}

func TestDHCPLeasesIncludesEthers(t *testing.T) {
	h := newHarness(fstest.MapFS{"etc/dnsmasq.d/sbx/ethers": {Data: []byte(ethers)}})
	m := resultMap(t, h.call(t, "dhcp.leases", nil))
	e := m["ethers"].([]any)
	if len(e) != 2 || e[1].(map[string]any)["mac"] != "02:01:00:00:01:f4" || e[1].(map[string]any)["ip"] != "10.88.0.101" {
		t.Errorf("ethers = %v", e)
	}
}
