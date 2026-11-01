package system

import (
	"context"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
)

// Idle thresholds and defaults (spec section 13).
const (
	// IdleCPUPercent: the average CPU usage over the window must be below.
	IdleCPUPercent = 5.0
	// IdleIOBytesPerMinute: network plus disk traffic over the window must
	// be below this rate.
	IdleIOBytesPerMinute = 16 << 20

	DefaultIdleWindow = 5 * time.Minute
	DefaultIdleTick   = 10 * time.Second
)

// IdleLoop decides whether the VM is idle (spec section 13). Every Tick it
// takes a sample; the VM is idle when for at least Window no command ran
// and no attach or TCP stream was open, and over the last Window the
// average CPU usage stayed below 5% and network plus disk traffic below
// 16 MiB per minute. Each change emits idle.changed{idle, since}.
//
// Running commands are taken from Counts as is, so a command with leftover
// processes still counts (stricter than the spec, which leaves leftovers to
// the CPU and traffic conditions).
type IdleLoop struct {
	// Counts gives running commands and attach streams; nil counts as zero.
	Counts Counts
	// DesktopStreams reports active video viewers.
	DesktopStreams func() uint32
	// TCP counts live CONNECT streams; nil counts as zero.
	TCP *ports.Counter
	// Sample returns the CPU usage in percent since the previous call and
	// the cumulative network plus disk bytes. Default NewSampler.
	Sample func() (cpuPercent float64, ioBytes uint64)
	// Window is how long the VM must be inactive. Default 5m.
	Window time.Duration
	// Tick is the sampling period. Default 10s.
	Tick time.Duration
	// Emit receives the events.
	Emit events.Emitter
	// Now is the clock. Default time.Now.
	Now func() time.Time

	// quietFrom is the first sample of the current run without work, zero
	// while work is running. samples covers the last window, the oldest
	// sample at or before its start. Only the loop goroutine touches them.
	quietFrom time.Time
	samples   []idleSample

	mu    sync.Mutex
	idle  bool
	since time.Time
}

// idleSample is one observation of the sample source.
type idleSample struct {
	at  time.Time
	cpu float64
	io  uint64
}

// IdleSince reports since when the VM is idle; ok is false while it is not.
func (l *IdleLoop) IdleSince() (since time.Time, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.since, l.idle
}

// Run samples every Tick until ctx ends.
func (l *IdleLoop) Run(ctx context.Context) {
	tick, now := l.Tick, l.Now
	if tick <= 0 {
		tick = DefaultIdleTick
	}
	if now == nil {
		now = time.Now
	}
	if l.Sample == nil {
		l.Sample = NewSampler(ctx)
	}
	l.step(now())
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			l.step(now())
		}
	}
}

// step takes one sample at now and updates the idle state.
func (l *IdleLoop) step(now time.Time) {
	window := l.Window
	if window <= 0 {
		window = DefaultIdleWindow
	}
	var running, attaches int
	if l.Counts != nil {
		running, _, attaches = l.Counts.Counts()
	}
	busy := running > 0 || attaches > 0 || loadTCP(l.TCP) > 0
	if l.DesktopStreams != nil && l.DesktopStreams() > 0 {
		busy = true
	}
	cpu, io := l.Sample()

	l.samples = append(l.samples, idleSample{at: now, cpu: cpu, io: io})
	cutoff := now.Add(-window)
	drop := 0
	for drop+1 < len(l.samples) && !l.samples[drop+1].at.After(cutoff) {
		drop++
	}
	l.samples = l.samples[drop:]

	switch {
	case busy:
		l.quietFrom = time.Time{}
	case l.quietFrom.IsZero():
		l.quietFrom = now
	}
	idle := !busy && !l.quietFrom.After(cutoff) && l.quietOver(now, window)

	l.mu.Lock()
	changed := idle != l.idle
	if changed {
		l.idle = idle
		if idle {
			l.since = cutoff
		} else {
			l.since = now
		}
	}
	since := l.since
	l.mu.Unlock()
	if changed && l.Emit != nil {
		l.Emit.Emit(events.TypeIdleChanged, &agentv1.IdleChanged{Idle: idle, Since: timestamppb.New(since)})
	}
}

// quietOver reports whether the samples of the last window average below
// the CPU and traffic thresholds. The first sample is the baseline at or
// before the window start; the CPU values of the later ones cover the
// window.
func (l *IdleLoop) quietOver(now time.Time, window time.Duration) bool {
	if len(l.samples) < 2 {
		return false
	}
	base, last := l.samples[0], l.samples[len(l.samples)-1]
	if now.Sub(base.at) < window {
		return false
	}
	var sum float64
	for _, s := range l.samples[1:] {
		sum += s.cpu
	}
	if sum/float64(len(l.samples)-1) >= IdleCPUPercent {
		return false
	}
	var delta uint64
	if last.io > base.io {
		delta = last.io - base.io
	}
	minutes := last.at.Sub(base.at).Minutes()
	return float64(delta)/minutes < IdleIOBytesPerMinute
}
