package system

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
)

// DefaultMetricsInterval is the CPU and network rate sampling period.
const DefaultMetricsInterval = 5 * time.Second

// GopsutilMetrics collects resource usage with gopsutil. CPU usage and the
// network rates come from a sample that Run refreshes every Interval, so
// Collect never waits for a measurement. Until the first refresh they are
// zero.
type GopsutilMetrics struct {
	// Interval is the sampling period of Run. Default 5s.
	Interval time.Duration
	// Log receives collection failures. Default slog.Default().
	Log *slog.Logger

	mu     sync.Mutex
	cpuPct float64
	rxBps  float64
	txBps  float64
}

var _ MetricsSource = (*GopsutilMetrics)(nil)

// Run refreshes the CPU and network rate sample every Interval until ctx
// ends.
func (g *GopsutilMetrics) Run(ctx context.Context) {
	interval := g.Interval
	if interval <= 0 {
		interval = DefaultMetricsInterval
	}
	var ct cpuTracker
	_, _ = ct.percent(ctx) // baseline
	prevAt := time.Now()
	prevRx, prevTx, _ := netTotals(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pct, err := ct.percent(ctx)
		if err != nil {
			g.log().Debug("sample cpu failed", "err", err)
		}
		now := time.Now()
		rx, tx, nerr := netTotals(ctx)
		if nerr != nil {
			g.log().Debug("sample network failed", "err", nerr)
		}
		secs := now.Sub(prevAt).Seconds()
		g.mu.Lock()
		g.cpuPct = pct
		if secs > 0 {
			g.rxBps = float64(subU64(rx, prevRx)) / secs
			g.txBps = float64(subU64(tx, prevTx)) / secs
		}
		g.mu.Unlock()
		prevAt, prevRx, prevTx = now, rx, tx
	}
}

// Collect implements MetricsSource. Failures of single parts are logged
// and leave them empty; Collect itself fails only when ctx is done.
func (g *GopsutilMetrics) Collect(ctx context.Context) (*agentv1.MetricsResponse, error) {
	log := g.log()
	g.mu.Lock()
	res := &agentv1.MetricsResponse{
		Cpu:     &agentv1.Cpu{UsagePercent: g.cpuPct},
		Network: &agentv1.Network{RxBps: g.rxBps, TxBps: g.txBps},
	}
	g.mu.Unlock()

	if n, err := cpu.CountsWithContext(ctx, true); err == nil {
		res.Cpu.Cores = clampU32(int64(n))
	} else {
		log.Debug("cpu count failed", "err", err)
	}
	if a, err := load.AvgWithContext(ctx); err == nil {
		res.Cpu.Load1, res.Cpu.Load5, res.Cpu.Load15 = a.Load1, a.Load5, a.Load15
	} else {
		log.Debug("load average failed", "err", err)
	}
	res.Memory = &agentv1.Memory{}
	if v, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		res.Memory.Total, res.Memory.Available, res.Memory.Used = v.Total, v.Available, v.Used
	} else {
		log.Debug("memory failed", "err", err)
	}
	if s, err := mem.SwapMemoryWithContext(ctx); err == nil {
		res.Memory.SwapTotal, res.Memory.SwapUsed = s.Total, s.Used
	} else {
		log.Debug("swap failed", "err", err)
	}
	res.Disks = collectDisks(ctx, log)
	if rx, tx, err := netTotals(ctx); err == nil {
		res.Network.RxBytes, res.Network.TxBytes = rx, tx
	} else {
		log.Debug("network failed", "err", err)
	}
	if pids, err := process.PidsWithContext(ctx); err == nil {
		res.Processes = clampU32(int64(len(pids)))
	} else {
		log.Debug("process list failed", "err", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return res, nil
}

func (g *GopsutilMetrics) log() *slog.Logger {
	if g.Log != nil {
		return g.Log
	}
	return slog.Default()
}

// collectDisks reports usage of the real block device mounts.
func collectDisks(ctx context.Context, log *slog.Logger) []*agentv1.Disk {
	parts, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		log.Debug("list mounts failed", "err", err)
		return nil
	}
	var out []*agentv1.Disk
	for _, p := range blockMounts(parts) {
		u, err := disk.UsageWithContext(ctx, p.Mountpoint)
		if err != nil {
			log.Debug("disk usage failed", "mount", p.Mountpoint, "err", err)
			continue
		}
		out = append(out, &agentv1.Disk{
			Mount:       p.Mountpoint,
			Total:       u.Total,
			Used:        u.Used,
			Free:        u.Free,
			InodesTotal: u.InodesTotal,
			InodesFree:  u.InodesFree,
		})
	}
	return out
}

// virtualFS lists file system types that are never block device mounts.
var virtualFS = map[string]bool{
	"autofs": true, "binfmt_misc": true, "bpf": true, "cgroup": true, "cgroup2": true,
	"configfs": true, "debugfs": true, "devpts": true, "devtmpfs": true, "efivarfs": true,
	"fusectl": true, "hugetlbfs": true, "mqueue": true, "nsfs": true, "overlay": true,
	"proc": true, "pstore": true, "ramfs": true, "rpc_pipefs": true, "securityfs": true,
	"squashfs": true, "sysfs": true, "tmpfs": true, "tracefs": true, "devfs": true,
	"nullfs": true, "iso9660": true,
}

// blockMounts keeps the mounts of real block devices: no virtual or
// read-only image file systems, no loop devices, one mount per device (the
// shortest path, so bind mounts do not repeat a disk).
func blockMounts(parts []disk.PartitionStat) []disk.PartitionStat {
	byDev := map[string]int{}
	var out []disk.PartitionStat
	for _, p := range parts {
		if virtualFS[p.Fstype] || strings.HasPrefix(p.Fstype, "fuse.") || p.Device == "" || p.Device == "none" {
			continue
		}
		if strings.HasPrefix(filepath.Base(p.Device), "loop") {
			continue
		}
		if i, ok := byDev[p.Device]; ok {
			if len(p.Mountpoint) < len(out[i].Mountpoint) {
				out[i] = p
			}
			continue
		}
		byDev[p.Device] = len(out)
		out = append(out, p)
	}
	slices.SortFunc(out, func(a, b disk.PartitionStat) int { return strings.Compare(a.Mountpoint, b.Mountpoint) })
	return out
}

// netTotals sums the received and sent bytes of the non-loopback
// interfaces.
func netTotals(ctx context.Context) (rx, tx uint64, err error) {
	ifs, err := net.IOCountersWithContext(ctx, true)
	if err != nil {
		return 0, 0, err
	}
	for _, c := range ifs {
		if isLoopback(c.Name) {
			continue
		}
		rx += c.BytesRecv
		tx += c.BytesSent
	}
	return rx, tx, nil
}

// isLoopback reports whether an interface name is a loopback device.
func isLoopback(name string) bool {
	return name == "lo" || strings.HasPrefix(name, "lo0") || strings.Contains(strings.ToLower(name), "loopback")
}

// diskTotal sums the read and written bytes of whole disks. On Linux the
// partitions are skipped (their traffic is in the disk's counters too), as
// are loop and RAM devices.
func diskTotal(ctx context.Context) (uint64, error) {
	stats, err := disk.IOCountersWithContext(ctx)
	if err != nil {
		return 0, err
	}
	var n uint64
	for name, s := range stats {
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "zram") {
			continue
		}
		if runtime.GOOS == "linux" {
			if _, err := os.Stat(filepath.Join("/sys/block", name)); err != nil {
				continue
			}
		}
		n += s.ReadBytes + s.WriteBytes
	}
	return n, nil
}

// cpuTracker computes the CPU usage between two calls from the cumulative
// CPU times. Each user keeps its own tracker; gopsutil's cpu.Percent with a
// zero interval shares one baseline per process.
type cpuTracker struct {
	last cpu.TimesStat
	ok   bool
}

// percent returns the busy share of all CPUs in percent since the previous
// call; the first call sets the baseline and returns 0.
func (c *cpuTracker) percent(ctx context.Context) (float64, error) {
	ts, err := cpu.TimesWithContext(ctx, false)
	if err != nil {
		return 0, err
	}
	if len(ts) == 0 {
		return 0, nil
	}
	cur := ts[0]
	prev, ok := c.last, c.ok
	c.last, c.ok = cur, true
	if !ok {
		return 0, nil
	}
	return busyPercent(prev, cur), nil
}

// busyPercent is the busy share between two CPU time samples, like
// gopsutil's own calculation.
func busyPercent(a, b cpu.TimesStat) float64 {
	aAll, aBusy := cpuBusy(a)
	bAll, bBusy := cpuBusy(b)
	switch {
	case bBusy <= aBusy:
		return 0
	case bAll <= aAll:
		return 100
	}
	return min(100, max(0, (bBusy-aBusy)/(bAll-aAll)*100))
}

// cpuBusy returns the total and busy CPU seconds of a sample. Guest time is
// already included in user time on Linux.
func cpuBusy(t cpu.TimesStat) (total, busy float64) {
	total = t.User + t.System + t.Idle + t.Nice + t.Iowait + t.Irq + t.Softirq + t.Steal
	if runtime.GOOS != "linux" {
		total += t.Guest + t.GuestNice
	}
	return total, total - t.Idle - t.Iowait
}

// NewSampler returns the default IdleLoop.Sample: CPU usage since the
// previous call and the cumulative network plus disk bytes. The CPU baseline
// is taken now; ctx bounds every read. On a CPU read failure it reports 100%
// so the VM is not taken for idle.
func NewSampler(ctx context.Context) func() (cpuPercent float64, ioBytes uint64) {
	ct := &cpuTracker{}
	_, _ = ct.percent(ctx)
	var mu sync.Mutex
	return func() (float64, uint64) {
		mu.Lock()
		defer mu.Unlock()
		pct, err := ct.percent(ctx)
		if err != nil {
			slog.Debug("idle sample cpu failed", "err", err)
			pct = 100
		}
		rx, tx, err := netTotals(ctx)
		if err != nil {
			slog.Debug("idle sample network failed", "err", err)
		}
		d, err := diskTotal(ctx)
		if err != nil {
			slog.Debug("idle sample disk failed", "err", err)
		}
		return pct, rx + tx + d
	}
}

// subU64 returns a-b, or 0 when the counter went back.
func subU64(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}
