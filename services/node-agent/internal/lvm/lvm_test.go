package lvm

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

const lvsJSON = `{
  "report": [
    {
      "lv": [
        {"lv_name":"base-599-disk-0", "lv_size":"42949672960", "lv_attr":"Vri---tz-k", "lv_tags":"sbx-tpl", "origin":"", "data_percent":"", "metadata_percent":"", "pool_lv":"data"},
        {"lv_name":"data", "lv_size":"748156928000", "lv_attr":"twi-aotz--", "lv_tags":"", "origin":"", "data_percent":"6.36", "metadata_percent":"0.71", "pool_lv":""},
        {"lv_name":"vm-500-disk-0", "lv_size":"42949672960", "lv_attr":"Vwi-a-tz--", "lv_tags":"sbx,sbx-vm-500", "origin":"base-599-disk-0", "data_percent":"10.00", "metadata_percent":"", "pool_lv":"data"}
      ]
    }
  ]
  ,
  "log": []
}`

type recorder struct {
	calls [][]string
	out   map[string]string
}

func (r *recorder) run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, append([]string{name}, args...))
	return []byte(r.out[name]), nil
}

func TestListParsesReport(t *testing.T) {
	r := &recorder{out: map[string]string{"lvs": lvsJSON}}
	e := &Exec{VG: "pve", Run: r.run}
	lvs, err := e.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(lvs) != 3 {
		t.Fatalf("got %d LVs", len(lvs))
	}
	want := LV{Name: "vm-500-disk-0", SizeBytes: 42949672960, Attr: "Vwi-a-tz--", Tags: []string{"sbx", "sbx-vm-500"}, Origin: "base-599-disk-0", DataPercent: 10, PoolLV: "data"}
	if !reflect.DeepEqual(lvs[2], want) {
		t.Errorf("lvs[2] = %+v, want %+v", lvs[2], want)
	}
	if lvs[1].MetadataPercent != 0.71 || len(lvs[0].Tags) != 1 || lvs[1].Tags == nil {
		t.Errorf("bad parse: %+v", lvs[:2])
	}
	if got := strings.Join(r.calls[0], " "); !strings.HasSuffix(got, " pve") || !strings.Contains(got, "--reportformat json") {
		t.Errorf("lvs call = %q", got)
	}
}

func TestCreateSnapshotAndRemoveCommands(t *testing.T) {
	r := &recorder{}
	e := &Exec{VG: "pve", Run: r.run}
	if err := e.CreateSnapshot(context.Background(), CreateSpec{Origin: "base-599-disk-0", Name: "vm-500-disk-0", Tags: []string{"sbx", "sbx-vm-500"}}); err != nil {
		t.Fatal(err)
	}
	if err := e.CreateSnapshot(context.Background(), CreateSpec{Origin: "vm-500-disk-0", Name: "sbx-snap-a-scsi0", Tags: []string{"sbx"}, ActivationSkip: true}); err != nil {
		t.Fatal(err)
	}
	if err := e.Remove(context.Background(), "vm-500-disk-0"); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"lvcreate -s -kn -n vm-500-disk-0 --addtag sbx --addtag sbx-vm-500 pve/base-599-disk-0",
		"lvcreate -s -ky -n sbx-snap-a-scsi0 --addtag sbx pve/vm-500-disk-0",
		"lvremove -y pve/vm-500-disk-0",
	}
	for i, w := range want {
		if got := strings.Join(r.calls[i], " "); got != w {
			t.Errorf("call %d = %q, want %q", i, got, w)
		}
	}
}

func TestAutoextendThreshold(t *testing.T) {
	r := &recorder{out: map[string]string{"lvmconfig": "thin_pool_autoextend_threshold=100\n"}}
	e := &Exec{VG: "pve", Run: r.run}
	v, err := e.AutoextendThreshold(context.Background())
	if err != nil || v != 100 {
		t.Fatalf("got %d, %v", v, err)
	}
}
