package quiesce

import (
	"reflect"
	"strings"
	"testing"
)

// mountInfoFixture covers bind mounts, btrfs subvolumes, read-only mounts,
// non-block filesystems, escapes and an over-mounted path.
const mountInfoFixture = `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,errors=remount-ro
23 22 8:1 /srv /mnt/bind rw,relatime shared:1 - ext4 /dev/sda1 rw
24 22 0:5 / /dev rw,nosuid - devtmpfs udev rw,size=1000k
25 22 8:17 / /data rw,noatime - xfs /dev/sdb1 rw,attr2
26 25 8:17 / /data/ro\040dir ro,noatime - xfs /dev/sdb1 rw,attr2
27 22 0:33 /@docker /var/lib/docker rw - btrfs /dev/sdc1 rw,subvol=/@docker
28 22 0:34 /@home /home rw - btrfs /dev/sdc1 rw,subvol=/@home
29 22 0:30 / /run rw,nosuid shared:5 - tmpfs tmpfs rw,mode=755
30 22 7:0 / /mnt/ro\040img ro - ext4 /dev/loop0 ro
31 22 8:49 / /mnt/space\040dir rw - ext4 /dev/sdd1 rw
32 22 0:40 / /overlay rw - overlay overlay rw,lowerdir=/a
33 22 8:65 / /mnt/hidden rw - ext4 /dev/sde1 rw
34 22 0:41 / /mnt/hidden rw - tmpfs tmpfs rw
35 22 8:81 / /srv/x rw - ext4 /dev/sdf1 ro
36 22 8:1 /a /var/b rw - ext4 /dev/disk/by-uuid/abc rw
37 22 0:50 / /net rw - ext4 server:/export rw
`

func TestParseMountInfo(t *testing.T) {
	entries, err := parseMountInfo(strings.NewReader(mountInfoFixture))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 16 {
		t.Fatalf("%d entries, want 16", len(entries))
	}
	tests := []struct {
		i    int
		want mountEntry
	}{
		{0, mountEntry{Path: "/", Source: "/dev/sda1", FSType: "ext4", Dev: "8:1"}},
		{4, mountEntry{Path: "/data/ro dir", Source: "/dev/sdb1", FSType: "xfs", Dev: "8:17", RO: true}},
		{9, mountEntry{Path: "/mnt/space dir", Source: "/dev/sdd1", FSType: "ext4", Dev: "8:49"}},
		{13, mountEntry{Path: "/srv/x", Source: "/dev/sdf1", FSType: "ext4", Dev: "8:81", RO: true}},
	}
	for _, tt := range tests {
		if got := entries[tt.i]; got != tt.want {
			t.Errorf("entry %d = %+v, want %+v", tt.i, got, tt.want)
		}
	}
	if _, err := parseMountInfo(strings.NewReader("1 2 3\n")); err == nil {
		t.Error("malformed line accepted")
	}
}

func TestSelectMounts(t *testing.T) {
	entries, err := parseMountInfo(strings.NewReader(mountInfoFixture))
	if err != nil {
		t.Fatal(err)
	}
	devs := map[string]uint64{
		"/dev/sda1": 1, "/dev/disk/by-uuid/abc": 1, "/dev/sdb1": 2,
		"/dev/sdc1": 3, "/dev/sdd1": 4, "/dev/sde1": 5, "/dev/sdf1": 6,
	}
	devOf := func(src string) (uint64, bool) {
		d, ok := devs[src]
		return d, ok
	}
	want := []Mount{
		{Path: "/mnt/space dir", Source: "/dev/sdd1", FSType: "ext4"},
		{Path: "/data", Source: "/dev/sdb1", FSType: "xfs"},
		{Path: "/home", Source: "/dev/sdc1", FSType: "btrfs"},
		{Path: "/", Source: "/dev/sda1", FSType: "ext4"},
	}
	if got := selectMounts(entries, devOf); !reflect.DeepEqual(got, want) {
		t.Errorf("selectMounts:\n got %+v\nwant %+v", got, want)
	}
	// Without device numbers the mountinfo major:minor groups the by-uuid
	// alias with /, and the btrfs subvolumes (anonymous 0:33 and 0:34)
	// group by source.
	if got := selectMounts(entries, nil); !reflect.DeepEqual(got, want) {
		t.Errorf("selectMounts without devOf:\n got %+v\nwant %+v", got, want)
	}
}

func TestUnescapeMount(t *testing.T) {
	tests := map[string]string{
		`/a\040b`:   "/a b",
		`/tab\011x`: "/tab\tx",
		`/bs\134`:   `/bs\`,
		`/short\04`: `/short\04`,
		`/plain`:    "/plain",
	}
	for in, want := range tests {
		if got := unescapeMount(in); got != want {
			t.Errorf("unescapeMount(%q) = %q, want %q", in, got, want)
		}
	}
}
