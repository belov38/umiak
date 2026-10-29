package claim

import (
	"context"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
)

// Docker phase timing.
const (
	dockerPollPending = 2 * time.Second
	dockerPollReady   = 30 * time.Second
	dockerPingTimeout = 5 * time.Second
)

// WatchDocker drives the docker readiness phase (spec 8.5) until ctx ends.
// Disabled sets the phase to disabled and returns. Otherwise the phase is
// ready while active reports docker.service active and ping (GET /_ping)
// succeeds, pending with the reason otherwise; it is checked every 2 s
// until ready, then every 30 s. A nil active or ping skips that check.
func WatchDocker(ctx context.Context, tr *readiness.Tracker, enabled bool, active func(context.Context) bool, ping func(context.Context) error) {
	watchDocker(ctx, tr, enabled, active, ping, dockerPollPending, dockerPollReady)
}

func watchDocker(ctx context.Context, tr *readiness.Tracker, enabled bool, active func(context.Context) bool, ping func(context.Context) error, fast, slow time.Duration) {
	if !enabled {
		tr.Set(readiness.PhaseDocker, agentv1.PhaseState_PHASE_STATE_DISABLED, "")
		return
	}
	for {
		state, msg := checkDocker(ctx, active, ping)
		if ctx.Err() != nil {
			return
		}
		tr.Set(readiness.PhaseDocker, state, msg)
		wait := fast
		if state == agentv1.PhaseState_PHASE_STATE_READY {
			wait = slow
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// checkDocker returns the docker phase state and its error text.
func checkDocker(ctx context.Context, active func(context.Context) bool, ping func(context.Context) error) (agentv1.PhaseState, string) {
	if active != nil && !active(ctx) {
		return agentv1.PhaseState_PHASE_STATE_PENDING, "docker.service is not active"
	}
	if ping != nil {
		pctx, cancel := context.WithTimeout(ctx, dockerPingTimeout)
		defer cancel()
		if err := ping(pctx); err != nil {
			return agentv1.PhaseState_PHASE_STATE_PENDING, "docker ping: " + err.Error()
		}
	}
	return agentv1.PhaseState_PHASE_STATE_READY, ""
}
