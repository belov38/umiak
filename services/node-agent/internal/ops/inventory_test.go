package ops

import (
	"testing"
	"testing/fstest"
	"time"
)

const qmList = `      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID
       100 hasp                 running    512                4.00 4068746
       599 sbx-ubuntu-poc       stopped    2048              40.00 0
`

const pctList = `VMID       Status     Lock         Name
104        running                 home-server
106        stopped    backup       ai
`

func inventoryFS() fstest.MapFS {
	old := time.Unix(1793200000, 0)
	recent := time.Unix(1793299000, 0)
	return fstest.MapFS{
		"etc/pve/sdn/zones.cfg":                 {Data: []byte("simple: sbx\n")},
		"etc/pve/sdn/vnets.cfg":                 {Data: []byte("vnet: sbx0\n")},
		"etc/pve/firewall/cluster.fw":           {Data: []byte("[OPTIONS]\n")},
		"etc/pve/firewall/500.fw":               {Data: []byte("[OPTIONS]\n")},
		"etc/pve/firewall/599.fw":               {Data: []byte("[OPTIONS]\n")},
		"etc/pve/nodes/pve/host.fw":             {Data: []byte("[OPTIONS]\nenable: 0\n")},
		"etc/pve/qemu-server/500.conf":          {Data: []byte("memory: 2048\n")},
		"etc/pve/qemu-server/101.conf":          {Data: []byte("memory: 2048\n")},
		"etc/network/interfaces":                {Data: []byte("auto lo\n")},
		"etc/network/interfaces.d/sdn":          {Data: []byte("auto sbx0\n")},
		"proc/sys/net/ipv4/ip_forward":          {Data: []byte("1\n")},
		"proc/sys/net/ipv6/conf/all/forwarding": {Data: []byte("0\n")},
		"proc/net/if_inet6":                     {Data: []byte("fe80000000000000a8bbccfffedd0011 0c 40 20 80     sbx0\nfe800000000000003a0525fffe3aa30a 05 40 20 80    vmbr0\n")},
		"etc/group":                             {Data: []byte("root:x:0:\nadm:x:4:\nsystemd-journal:x:999:alice,bob\n")},
		"var/log/pve/tasks/A/UPID:pve:old":      {Data: []byte("TOKEN-X"), ModTime: old},
		"var/log/pve/tasks/B/UPID:pve:recent":   {Data: []byte("nothing here"), ModTime: recent},
		"proc/1234/cmdline":                     {Data: []byte("/usr/bin/kvm\x00-smbios\x00type=1,serial=TOKEN-X\x00")},
		"proc/99/cmdline":                       {Data: []byte("/usr/sbin/sshd\x00TOKEN-X\x00")},
	}
}

func TestInventoryDefaultSections(t *testing.T) {
	h := newHarness(inventoryFS())
	h.run.out["qm"] = qmList
	h.run.out["pct"] = pctList
	m := resultMap(t, h.call(t, "inventory", nil))

	guests := m["guests"].(map[string]any)
	qm := guests["qm"].([]any)
	if len(qm) != 2 || qm[1].(map[string]any)["name"] != "sbx-ubuntu-poc" || qm[0].(map[string]any)["status"] != "running" {
		t.Errorf("qm = %v", qm)
	}
	pct := guests["pct"].([]any)
	if len(pct) != 2 || pct[1].(map[string]any)["lock"] != "backup" || pct[0].(map[string]any)["name"] != "home-server" {
		t.Errorf("pct = %v", pct)
	}

	lvs := m["lvs"].([]any)
	for _, l := range lvs {
		if l.(map[string]any)["name"] == "vm-500-disk-0" {
			t.Errorf("lvs must exclude sbx-tagged LVs: %v", lvs)
		}
	}
	if len(lvs) != 3 {
		t.Errorf("lvs = %v", lvs)
	}

	hashes := m["hashes"].(map[string]any)
	for _, p := range []string{"/etc/pve/sdn/zones.cfg", "/etc/pve/firewall/cluster.fw", "/etc/pve/firewall/599.fw", "/etc/pve/nodes/pve/host.fw", "/etc/network/interfaces", "/etc/network/interfaces.d/sdn"} {
		if _, ok := hashes[p]; !ok {
			t.Errorf("hash missing for %s: %v", p, hashes)
		}
	}
	if _, ok := hashes["/etc/pve/firewall/500.fw"]; ok {
		t.Error("per-VM firewall files of the range must not be hashed")
	}

	sysctl := m["sysctl"].(map[string]any)
	if sysctl["net.ipv4.ip_forward"] != "1" || sysctl["net.ipv6.conf.all.forwarding"] != "0" {
		t.Errorf("sysctl = %v", sysctl)
	}
	if m["sbx0"].(map[string]any)["linkLocal"] != "fe80::a8bb:ccff:fedd:11" {
		t.Errorf("sbx0 = %v", m["sbx0"])
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
	fs["proc/net/if_inet6"] = &fstest.MapFile{Data: []byte("fe80000000000000a8bbccfffedd0011 0c 40 20 80     sbx0\n")}
	m := resultMap(t, newHarness(fs).call(t, "inventory", map[string]any{"sections": []string{"sbx0"}}))
	if got := m["sbx0"].(map[string]any)["linkLocal"]; got != "fe80::a8bb:ccff:fedd:11" {
		t.Errorf("linkLocal = %v", got)
	}
}

func TestInventorySearchScopes(t *testing.T) {
	h := newHarness(inventoryFS())
	h.run.out["journalctl"] = "unrelated\n"
	m := resultMap(t, h.call(t, "inventory", map[string]any{"sections": []string{"search"}, "search": "TOKEN-X", "since": 1793290000}))
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
