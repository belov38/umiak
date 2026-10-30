package main

import (
	"context"
	"sync"
	"time"

	"golang.org/x/sys/windows/svc"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/agent"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

// exitRestart is the exit code of an agent that asks to be started again
// (an applied update, a reverted update, a changed identity). The process
// ends without reporting SERVICE_STOPPED, so the failure actions of the
// service restart it from the current version (S9 spec 12.2).
const exitRestart = 75

// Status timings reported to the service control manager.
const (
	// pendingWaitHint is the wait hint of a start or stop in progress; the
	// checkpoint grows every pendingTick, so a slow start is not taken for
	// a hung one.
	pendingWaitHint = 30 * time.Second
	pendingTick     = 5 * time.Second
)

// agentHooks connect one agent run to the service control manager. The
// zero value is a console run.
type agentHooks struct {
	// service is set under the service control manager.
	service bool
	// notify takes the sd_notify states of the agent (READY=1,
	// STOPPING=1); nil drops them.
	notify func(state string) error
	// preShutdown is closed on PRESHUTDOWN (agent.Deps.PreShutdown).
	preShutdown <-chan struct{}
}

// serviceHandler runs the agent as the sbx-agent service: START_PENDING
// until the agent reports READY=1, then RUNNING accepting Stop and
// PreShutdown. Stop cancels the run; PreShutdown first lets the agent wipe
// the secrets and flush the store, and cancels the run after
// preShutdownWait in case the agent hangs. A run that ends without a stop
// request is an agent asking to be restarted: exit(exitRestart) ends the
// process without SERVICE_STOPPED.
type serviceHandler struct {
	run  func(ctx context.Context, hooks agentHooks) int
	exit func(code int)
	// preShutdownWait is the fallback cancel after PRESHUTDOWN, for an
	// agent that hangs in its preshutdown steps: agent.PreShutdownBudget
	// plus 1 s by default, which leaves the final shutdown flush inside the
	// 15 s preshutdown timeout of the service. tick defaults to
	// pendingTick.
	preShutdownWait time.Duration
	tick            time.Duration
}

// Execute implements svc.Handler.
func (h *serviceHandler) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	preWait, tickEvery := h.preShutdownWait, h.tick
	if preWait <= 0 {
		preWait = agent.PreShutdownBudget + time.Second
	}
	if tickEvery <= 0 {
		tickEvery = pendingTick
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	notes := make(chan string)
	pre := make(chan struct{})
	done := make(chan int, 1)
	hooks := agentHooks{
		service:     true,
		preShutdown: pre,
		// Execute reads notes until the run returns, so the send never
		// blocks for long.
		notify: func(state string) error {
			notes <- state
			return nil
		},
	}
	go func() { done <- h.run(ctx, hooks) }()

	cur := svc.Status{State: svc.StartPending, WaitHint: uint32(pendingWaitHint.Milliseconds())}
	s <- cur
	set := func(st svc.Status) {
		cur = st
		s <- cur
	}
	stopPending := func() {
		if cur.State != svc.StopPending {
			set(svc.Status{State: svc.StopPending, WaitHint: uint32(update.PreshutdownTimeout.Milliseconds())})
		}
	}
	tick := time.NewTicker(tickEvery)
	defer tick.Stop()
	var preOnce sync.Once
	var preTimer *time.Timer
	defer func() {
		if preTimer != nil {
			preTimer.Stop()
		}
	}()
	stopping := false
	for {
		select {
		case n := <-notes:
			switch n {
			case "READY=1":
				if cur.State == svc.StartPending {
					set(svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptPreShutdown})
				}
			case "STOPPING=1":
				stopPending()
			}
		case <-tick.C:
			if cur.State == svc.StartPending || cur.State == svc.StopPending {
				cur.CheckPoint++
				s <- cur
			}
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- cur
			case svc.Stop:
				stopping = true
				stopPending()
				cancel()
			case svc.PreShutdown:
				stopping = true
				stopPending()
				preOnce.Do(func() {
					close(pre)
					preTimer = time.AfterFunc(preWait, cancel)
				})
			}
		case code := <-done:
			switch {
			case stopping:
				return false, 0
			case code == 0:
				h.exit(exitRestart)
				return true, exitRestart
			default:
				return true, uint32(code) //nolint:gosec // exit codes are small and non-negative
			}
		}
	}
}

// serviceDeps wires install-package, rollback and doctor to the service
// control manager.
func serviceDeps(d *deps) {
	l := d.layout
	d.services = update.SCMManager{}
	d.systemPath = true
	d.doctorUnits = []agent.DoctorUnit{{Key: "sbx-agent", Unit: update.AgentService}}
	d.isActive = func(_ context.Context, name string) string { return update.ServiceState(name) }
	d.doctorService = func(context.Context) *agent.ServiceReport { return checkService(l, update.AgentService) }
}

// checkService reports the agent service for doctor.
func checkService(l paths.Layout, name string) *agent.ServiceReport {
	r := &agent.ServiceReport{Name: name}
	c, err := update.CheckService(l, name)
	if err != nil {
		r.Error = err.Error()
		return r
	}
	r.State, r.Problems, r.Configured = c.State, c.Problems, len(c.Problems) == 0
	return r
}
