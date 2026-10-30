package system

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
)

func TestBlockMounts(t *testing.T) {
	parts := []disk.PartitionStat{
		{Device: "/dev/vda1", Mountpoint: "/", Fstype: "ext4"},
		{Device: "tmpfs", Mountpoint: "/run", Fstype: "tmpfs"},
		{Device: "overlay", Mountpoint: "/var/lib/docker/overlay2/x/merged", Fstype: "overlay"},
		{Device: "proc", Mountpoint: "/proc", Fstype: "proc"},
		{Device: "/dev/vda1", Mountpoint: "/etc/hosts", Fstype: "ext4"},
		{Device: "/dev/vdb", Mountpoint: "/data", Fstype: "xfs"},
		{Device: "/dev/loop3", Mountpoint: "/snap/core/1", Fstype: "squashfs"},
		{Device: "/dev/loop4", Mountpoint: "/mnt/img", Fstype: "ext4"},
		{Device: "sshfs", Mountpoint: "/mnt/remote", Fstype: "fuse.sshfs"},
		{Device: "/dev/vda15", Mountpoint: "/boot/efi", Fstype: "vfat"},
		{Device: "cgroup2", Mountpoint: "/sys/fs/cgroup", Fstype: "cgroup2"},
	}
	var got []string
	for _, p := range blockMounts(parts) {
		got = append(got, p.Mountpoint)
	}
	want := []string{"/", "/boot/efi", "/data"}
	if !slices.Equal(got, want) {
		t.Fatalf("blockMounts = %q, want %q", got, want)
	}
}

func TestBusyPercent(t *testing.T) {
	tests := []struct {
		name string
		a, b cpu.TimesStat
		want float64
	}{
		{"half busy", cpu.TimesStat{User: 10, Idle: 10}, cpu.TimesStat{User: 15, Idle: 15}, 50},
		{"idle", cpu.TimesStat{User: 10, Idle: 10}, cpu.TimesStat{User: 10, Idle: 20}, 0},
		{"iowait is not busy", cpu.TimesStat{User: 10, Idle: 10}, cpu.TimesStat{User: 11, Idle: 15, Iowait: 14}, 5},
		{"no change", cpu.TimesStat{User: 10}, cpu.TimesStat{User: 10}, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := busyPercent(tc.a, tc.b); got != tc.want {
				t.Fatalf("busyPercent = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestGopsutilMetricsCollect(t *testing.T) {
	g := &GopsutilMetrics{Interval: 20 * time.Millisecond}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		g.Run(ctx)
	}()
	time.Sleep(60 * time.Millisecond)
	res, err := g.Collect(t.Context())
	cancel()
	<-done
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if res.GetCpu().GetCores() == 0 || res.GetMemory().GetTotal() == 0 || res.GetProcesses() == 0 {
		t.Fatalf("Collect = %v", res)
	}
	if u := res.GetCpu().GetUsagePercent(); u < 0 || u > 100 {
		t.Fatalf("cpu usage %v", u)
	}
	for _, d := range res.GetDisks() {
		if d.GetMount() == "" || d.GetTotal() == 0 {
			t.Fatalf("disk %v", d)
		}
	}
}

func TestNewSampler(t *testing.T) {
	s := NewSampler(t.Context())
	time.Sleep(20 * time.Millisecond)
	cpu1, io1 := s()
	cpu2, io2 := s()
	if cpu1 < 0 || cpu1 > 100 || cpu2 < 0 || cpu2 > 100 {
		t.Fatalf("cpu %v %v", cpu1, cpu2)
	}
	if io2 < io1 {
		t.Fatalf("io bytes went back: %d -> %d", io1, io2)
	}
}
