package agent

import (
	"context"
	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/desktop"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
	"sync/atomic"
	"testing"
	"time"
)

func TestDesktopDoesNotStartBeforeClaim(t *testing.T) {
	service, err := desktop.New(desktop.Options{Enabled: true, Identity: machineA, Dir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	tracker := readiness.New([]string{"desktop"}, nil, time.Now)
	tracker.Set("secrets", v1.PhaseState_PHASE_STATE_READY, "")
	var starts atomic.Int32
	a := &agent{cfg: config.Config{DesktopEnabled: true}, tracker: tracker, desktop: service, desktopStart: func(context.Context) error { starts.Add(1); return nil }}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	a.desktopLoop(ctx)
	if starts.Load() != 0 {
		t.Fatal("started an interactive desktop before claim")
	}
}
