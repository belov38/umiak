package agent

import (
	"context"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// desktopLoop publishes readiness from the session adapter independently of video.
func (a *agent) desktopLoop(ctx context.Context) {
	if !a.cfg.DesktopEnabled {
		return
	}
	started := false
	prepared := false
	sample := func() {
		phases, _ := a.tracker.Snapshot()
		secretsReady := false
		for _, p := range phases {
			if p.Name == "secrets" && p.State == v1.PhaseState_PHASE_STATE_READY {
				secretsReady = true
			}
		}
		state := v1.PhaseState_PHASE_STATE_PENDING
		reason := "desktop_not_ready"
		if secretsReady {
			if !prepared {
				if err := a.desktop.PrepareRuntime(ctx); err != nil {
					a.tracker.Set("desktop", v1.PhaseState_PHASE_STATE_PENDING, "desktop_not_ready")
					return
				}
				prepared = true
			}
			if !started && a.desktopStart != nil {
				if err := a.desktopStart(ctx); err != nil {
					a.tracker.Set("desktop", v1.PhaseState_PHASE_STATE_PENDING, "desktop_not_ready")
					return
				}
				started = true
			}
			a.desktop.PollViewers(ctx)
			r, err := a.desktop.Status(ctx, connect.NewRequest(&v1.DesktopStatusRequest{}))
			if err == nil && r.Msg.State == "ready" {
				state = v1.PhaseState_PHASE_STATE_READY
				reason = ""
			}
		}
		a.tracker.Set("desktop", state, reason)
	}
	sample()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sample()
		}
	}
}
