package system

import (
	"context"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
)

// Defaults of ActivityLoop.
const (
	DefaultActivityHeartbeat = 60 * time.Second
	DefaultActivityTick      = time.Second
)

// ActivityLoop emits the activity event (Decision 3, S6 idle-stop): the
// first sample after start, on any change between zero and non-zero of
// running commands, open PTYs or TCP streams, and as a heartbeat when no
// event was sent for Heartbeat.
type ActivityLoop struct {
	// Counts gives running commands and open PTYs; nil counts as zero.
	Counts Counts
	// DesktopStreams reports active video viewers. Nil counts as zero.
	DesktopStreams func() uint32
	// TCP counts live CONNECT streams; nil counts as zero.
	TCP *ports.Counter
	// Emit receives the events.
	Emit events.Emitter
	// Heartbeat is the longest gap between two events. Default 60s.
	Heartbeat time.Duration
	// Tick is the sampling period. Default 1s.
	Tick time.Duration
	// Now is the clock. Default time.Now.
	Now func() time.Time

	started bool
	last    [4]int64
	sentAt  time.Time
}

// Run samples the counters every Tick until ctx ends.
func (l *ActivityLoop) Run(ctx context.Context) {
	tick, now := l.Tick, l.Now
	if tick <= 0 {
		tick = DefaultActivityTick
	}
	if now == nil {
		now = time.Now
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

// step takes one sample at now and emits an event if one is due.
func (l *ActivityLoop) step(now time.Time) {
	var running, ptys int
	if l.Counts != nil {
		running, ptys, _ = l.Counts.Counts()
	}
	cur := [4]int64{int64(running), int64(ptys), loadTCP(l.TCP), 0}
	if l.DesktopStreams != nil {
		cur[3] = int64(l.DesktopStreams())
	}
	heartbeat := l.Heartbeat
	if heartbeat <= 0 {
		heartbeat = DefaultActivityHeartbeat
	}
	due := !l.started || now.Sub(l.sentAt) >= heartbeat
	for i := range cur {
		if (cur[i] > 0) != (l.last[i] > 0) {
			due = true
		}
	}
	l.last = cur
	if !due {
		return
	}
	l.started, l.sentAt = true, now
	if l.Emit != nil {
		l.Emit.Emit(events.TypeActivity, &agentv1.Activity{
			RunningCommands: clampU32(cur[0]),
			OpenPtys:        clampU32(cur[1]),
			TcpStreams:      clampU32(cur[2]),
			DesktopStreams:  clampU32(cur[3]),
		})
	}
}
