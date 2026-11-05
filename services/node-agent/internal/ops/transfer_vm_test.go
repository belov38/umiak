package ops

import (
	"testing"
	"testing/fstest"
)

func TestTransferVMRequiresOwnedStoppedIdentity(t *testing.T) {
	h := newHarness(fstest.MapFS{"etc/pve/qemu-server/500.conf": {Data: []byte("tags: umiak\nsmbios1: uuid=11111111-1111-4111-8111-111111111111\n")}, "etc/pve/nodes/pve2/qemu-server": {Mode: 0o755 | 1<<31}})
	for _, a := range []map[string]any{
		{"vmid": 108, "target": "pve2", "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "machineId": "11111111-1111-4111-8111-111111111111", "storage": "local-lvm"},
		{"vmid": 500, "target": "../other", "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "machineId": "11111111-1111-4111-8111-111111111111", "storage": "local-lvm"},
		{"vmid": 500, "target": "pve2", "id": "bad", "machineId": "11111111-1111-4111-8111-111111111111", "storage": "local-lvm"},
	} {
		if h.call(t, "vm.transferSwitch", a).OK {
			t.Fatal("unowned relocation permitted")
		}
	}
	if len(h.run.calls) != 0 {
		t.Fatal("invalid request executed a command")
	}
}
func TestTransferVMSwitchUsesFixedPVELockHelper(t *testing.T) {
	h := newHarness(fstest.MapFS{"etc/pve/qemu-server/500.conf": {Data: []byte("tags: umiak\nsmbios1: uuid=11111111-1111-4111-8111-111111111111\n")}, "etc/pve/nodes/pve2/qemu-server": {Mode: 0o755 | 1<<31}})
	h.run.out["qm"] = "status: stopped\n"
	r := h.call(t, "vm.transferSwitch", map[string]any{"vmid": 500, "target": "pve2", "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "machineId": "11111111-1111-4111-8111-111111111111", "storage": "local-lvm"})
	if !r.OK {
		t.Fatalf("%v", r.Error)
	}
	if h.run.calls[len(h.run.calls)-1][0] != "perl" {
		t.Fatal("missing locked PVE config helper")
	}
}
