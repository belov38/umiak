package ops

import (
	"slices"
	"testing"
	"testing/fstest"
	"time"

	"github.com/belov38/umiak/services/node-agent/internal/lvm"
)

const qmList = `      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       100 hasp                 running    512                4.00 4068746
       598 umiak-tpl-windows-1    running    8192              64.00 4068750
       599 umiak-ubuntu-poc       stopped    2048              40.00 0
       590 umiak-dev-cp-vm        running    1024               8.00 4068751
`

const pctList = `VMID       Status     Lock         Name
104        running                 home-server
106        stopped    backup       ai
`

func inventoryFS() fstest.MapFS {
	old := time.Unix(1793200000, 0)
	recent := time.Unix(1793299000, 0)
	return fstest.MapFS{
		"etc/pve/sdn/zones.cfg":                 {Data: []byte("simple: umiak\n")},
		"etc/pve/sdn/vnets.cfg":                 {Data: []byte("vnet: umiak0\n")},
		"etc/pve/firewall/cluster.fw":           {Data: []byte("[OPTIONS]\n")},
		"etc/pve/firewall/500.fw":               {Data: []byte("[OPTIONS]\n")},
		"etc/pve/firewall/599.fw":               {Data: []byte("[OPTIONS]\n")},
		"etc/pve/firewall/598.fw":               {Data: []byte("[OPTIONS]\n")},
		"etc/pve/firewall/590.fw":               {Data: []byte("[OPTIONS]\n")},
		"etc/pve/nodes/pve/host.fw":             {Data: []byte("[OPTIONS]\nenable: 0\n")},
		"etc/pve/qemu-server/500.conf":          {Data: []byte("memory: 2048\n")},
		"etc/pve/qemu-server/101.conf":          {Data: []byte("memory: 2048\n")},
		"etc/network/interfaces":                {Data: []byte("auto lo\n")},
		"etc/network/interfaces.d/sdn":          {Data: []byte("auto umiak0\n")},
		"proc/sys/net/ipv4/ip_forward":          {Data: []byte("1\n")},
		"proc/sys/net/ipv6/conf/all/forwarding": {Data: []byte("0\n")},
		"proc/net/if_inet6":                     {Data: []byte("fe80000000000000a8bbccfffedd0011 0c 40 20 80     umiak0\nfe800000000000003a0525fffe3aa30a 05 40 20 80    vmbr0\n")},
		"etc/group":                             {Data: []byte("root:x:0:\nadm:x:4:\nsystemd-journal:x:999:alice,bob\n")},
		"var/log/pve/tasks/A/UPID:pve:old":      {Data: []byte(testSerial), ModTime: old},
		"var/log/pve/tasks/B/UPID:pve:recent":   {Data: []byte("nothing here"), ModTime: recent},
		"proc/1234/cmdline":                     {Data: []byte("/usr/bin/kvm\x00-smbios\x00type=1,serial=" + testSerial + "\x00")},
		"proc/99/cmdline":                       {Data: []byte("/usr/sbin/sshd\x00" + testSerial + "\x00")},
	}
}

func TestInventoryDefaultSections(t *testing.T) {
	h := newHarness(inventoryFS())
	h.run.out["qm"] = qmList
	h.run.out["pct"] = pctList
	m := resultMap(t, h.call(t, "inventory", nil))

	guests := m["guests"].(map[string]any)
	qm := guests["qm"].([]any)
	// Template slots (598 a build, 599 the PoC template) are ours; 590 is dev infrastructure.
	if len(qm) != 2 || qm[0].(map[string]any)["vmid"].(float64) != 100 || qm[1].(map[string]any)["vmid"].(float64) != 590 || qm[0].(map[string]any)["status"] != "running" {
		t.Errorf("qm = %v", qm)
	}
	pct := guests["pct"].([]any)
	if len(pct) != 2 || pct[1].(map[string]any)["lock"] != "backup" || pct[0].(map[string]any)["name"] != "home-server" {
		t.Errorf("pct = %v", pct)
	}

	lvs := m["lvs"].([]any)
	for _, l := range lvs {
		if l.(map[string]any)["name"] == "vm-500-disk-0" {
			t.Errorf("lvs must exclude umiak-tagged LVs: %v", lvs)
		}
	}
	for _, l := range lvs {
		if l.(map[string]any)["name"] == "base-599-disk-0" {
			t.Errorf("lvs must exclude the template LV tagged umiak-tpl: %v", lvs)
		}
	}
	if len(lvs) != 2 {
		t.Errorf("lvs = %v", lvs)
	}

	hashes := m["hashes"].(map[string]any)
	for _, p := range []string{"/etc/pve/sdn/zones.cfg", "/etc/pve/firewall/cluster.fw", "/etc/pve/firewall/599.fw", "/etc/pve/nodes/pve/host.fw", "/etc/network/interfaces", "/etc/network/interfaces.d/sdn"} {
		if _, ok := hashes[p]; !ok {
			t.Errorf("hash missing for %s: %v", p, hashes)
		}
	}
	for _, p := range []string{"/etc/pve/firewall/500.fw", "/etc/pve/firewall/598.fw"} {
		if _, ok := hashes[p]; ok {
			t.Errorf("%s: per-VM firewall files of sandboxes and template builds must not be hashed", p)
		}
	}
	if _, ok := hashes["/etc/pve/firewall/590.fw"]; !ok {
		t.Error("dev infrastructure (590) firewall must be hashed")
	}

	sysctl := m["sysctl"].(map[string]any)
	if sysctl["net.ipv4.ip_forward"] != "1" || sysctl["net.ipv6.conf.all.forwarding"] != "0" {
		t.Errorf("sysctl = %v", sysctl)
	}
	if m["umiak0"].(map[string]any)["linkLocal"] != "fe80::a8bb:ccff:fedd:11" {
		t.Errorf("umiak0 = %v", m["umiak0"])
	}
	vmfiles := m["vmfiles"].([]any)
	if len(vmfiles) != 2 {
		t.Errorf("vmfiles = %v", vmfiles)
	}
	readers := m["journalReaders"].(map[string]any)
	if r := readers["systemd-journal"].([]any); len(r) != 2 {
		t.Errorf("journalReaders = %v", readers)
	}
	if _, ok := m["search"]; ok {
		t.Error("search must only run when requested")
	}
}

func TestInventoryLinkLocal(t *testing.T) {
	fs := inventoryFS()
	fs["proc/net/if_inet6"] = &fstest.MapFile{Data: []byte("fe80000000000000a8bbccfffedd0011 0c 40 20 80     umiak0\n")}
	m := resultMap(t, newHarness(fs).call(t, "inventory", map[string]any{"sections": []string{"umiak0"}}))
	if got := m["umiak0"].(map[string]any)["linkLocal"]; got != "fe80::a8bb:ccff:fedd:11" {
		t.Errorf("linkLocal = %v", got)
	}
}

func TestInventorySearchScopes(t *testing.T) {
	h := newHarness(inventoryFS())
	h.run.out["journalctl"] = "unrelated\n"
	m := resultMap(t, h.call(t, "inventory", map[string]any{"sections": []string{"search"}, "search": testSerial, "since": 1793290000}))
	s := m["search"].(map[string]any)
	if s["journal"] != false || s["tasklog"] != false || s["qemuCmdline"] != true {
		t.Errorf("search = %v (old task log must be ignored, non-kvm cmdline ignored)", s)
	}
	if _, ok := m["guests"]; ok {
		t.Error("only requested sections must be returned")
	}
}

func TestInventoryRejectsUnknownSection(t *testing.T) {
	r := newHarness(nil).call(t, "inventory", map[string]any{"sections": []string{"secrets"}})
	if r.OK || r.Error.Code != "bad_request" {
		t.Errorf("got %+v", r)
	}
}

func TestInventoryHashesJSONCanonically(t *testing.T) {
	hash := func(body string) any {
		fs := inventoryFS()
		fs["etc/pve/sdn/pve-ipam-state.json"] = &fstest.MapFile{Data: []byte(body)}
		m := resultMap(t, newHarness(fs).call(t, "inventory", map[string]any{"sections": []string{"hashes"}}))
		return m["hashes"].(map[string]any)["/etc/pve/sdn/pve-ipam-state.json"]
	}
	a := hash(`{"zones":{"umiak":{"ips":{"10.88.0.1":{"gateway":1},"10.88.0.100":{"vmid":"599","mac":"x"}}}}}`)
	b := hash(`{"zones":{"umiak":{"ips":{"10.88.0.100":{"mac":"x","vmid":"599"},"10.88.0.1":{"gateway":1}}}}}`)
	c := hash(`{"zones":{"umiak":{"ips":{"10.88.0.1":{"gateway":1}}}}}`)
	if a != b || a == c {
		t.Errorf("a=%v b=%v c=%v", a, b, c)
	}
}

// A template build (S9 in 598) creates untagged volumes; they are not the world. A volume of dev
// infrastructure (590) or of another guest stays foreign.
func TestInventoryLVsSkipTemplateSlotVolumes(t *testing.T) {
	h := newHarness(inventoryFS())
	h.lvm.lvs = append(h.lvm.lvs,
		lvm.LV{Name: "vm-598-disk-0", Tags: []string{}, PoolLV: "data"},
		lvm.LV{Name: "vm-598-disk-1", Tags: []string{}, PoolLV: "data"},
		lvm.LV{Name: "base-597-disk-0", Tags: []string{}, PoolLV: "data"},
		lvm.LV{Name: "vm-590-disk-0", Tags: []string{}, PoolLV: "data"},
		lvm.LV{Name: "vm-5980-disk-0", Tags: []string{}, PoolLV: "data"},
	)
	m := resultMap(t, h.call(t, "inventory", map[string]any{"sections": []string{"lvs"}}))
	names := []string{}
	for _, l := range m["lvs"].([]any) {
		names = append(names, l.(map[string]any)["name"].(string))
	}
	slices.Sort(names)
	want := []string{"data", "vm-108-disk-1", "vm-590-disk-0", "vm-5980-disk-0"}
	if !slices.Equal(names, want) {
		t.Errorf("lvs = %v, want %v", names, want)
	}
}
