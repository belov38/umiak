package main

import (
	"context"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
)

// handlerRun drives serviceHandler.Execute with a fake agent run.
type handlerRun struct {
	r      chan svc.ChangeRequest
	s      chan svc.Status
	result chan [2]uint32
	exits  chan int
}

func startHandler(t *testing.T, run func(ctx context.Context, hooks agentHooks) int) *handlerRun {
	t.Helper()
	hr := &handlerRun{
		r:      make(chan svc.ChangeRequest),
		s:      make(chan svc.Status, 64),
		result: make(chan [2]uint32, 1),
		exits:  make(chan int, 1),
	}
	h := &serviceHandler{run: run, exit: func(code int) { hr.exits <- code }, preShutdownWait: 2 * time.Second, tick: time.Hour}
	go func() {
		spec, code := h.Execute(nil, hr.r, hr.s)
		var b uint32
		if spec {
			b = 1
		}
		hr.result <- [2]uint32{b, code}
	}()
	return hr
}

// waitState reads statuses until state arrives.
func (hr *handlerRun) waitState(t *testing.T, state svc.State) svc.Status {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case st := <-hr.s:
			if st.State == state {
				return st
			}
		case <-timeout:
			t.Fatalf("no state %d", state)
		}
	}
}

func (hr *handlerRun) wait(t *testing.T) (bool, uint32) {
	t.Helper()
	select {
	case r := <-hr.result:
		return r[0] == 1, r[1]
	case <-time.After(10 * time.Second):
		t.Fatal("Execute did not return")
		return false, 0
	}
}

func TestServiceHandlerStop(t *testing.T) {
	hr := startHandler(t, func(ctx context.Context, hooks agentHooks) int {
		_ = hooks.notify("READY=1")
		<-ctx.Done()
		_ = hooks.notify("STOPPING=1")
		return 0
	})
	hr.waitState(t, svc.StartPending)
	st := hr.waitState(t, svc.Running)
	if st.Accepts != svc.AcceptStop|svc.AcceptPreShutdown {
		t.Errorf("accepts = %v", st.Accepts)
	}
	hr.r <- svc.ChangeRequest{Cmd: svc.Stop}
	hr.waitState(t, svc.StopPending)
	if spec, code := hr.wait(t); spec || code != 0 {
		t.Errorf("Execute = %t, %d; want a clean stop", spec, code)
	}
	select {
	case code := <-hr.exits:
		t.Errorf("exit(%d) on a requested stop", code)
	default:
	}
}

// An agent that ends without a stop request (self-update) exits with
// exitRestart and does not report SERVICE_STOPPED.
func TestServiceHandlerSelfUpdateExit(t *testing.T) {
	hr := startHandler(t, func(_ context.Context, hooks agentHooks) int {
		_ = hooks.notify("READY=1")
		_ = hooks.notify("STOPPING=1")
		return 0
	})
	select {
	case code := <-hr.exits:
		if code != exitRestart {
			t.Errorf("exit code = %d, want %d", code, exitRestart)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no exit")
	}
	hr.wait(t)
}

func TestServiceHandlerPreShutdown(t *testing.T) {
	wiped := make(chan struct{})
	hr := startHandler(t, func(ctx context.Context, hooks agentHooks) int {
		_ = hooks.notify("READY=1")
		select {
		case <-hooks.preShutdown:
			close(wiped)
		case <-ctx.Done():
			t.Error("cancelled before PreShutdown reached the agent")
		}
		<-ctx.Done() // the fallback cancel after preShutdownWait
		return 0
	})
	hr.waitState(t, svc.Running)
	hr.r <- svc.ChangeRequest{Cmd: svc.PreShutdown}
	hr.waitState(t, svc.StopPending)
	<-wiped
	if spec, code := hr.wait(t); spec || code != 0 {
		t.Errorf("Execute = %t, %d", spec, code)
	}
}

func TestServiceHandlerStartFailure(t *testing.T) {
	hr := startHandler(t, func(context.Context, agentHooks) int { return 1 })
	if spec, code := hr.wait(t); !spec || code != 1 {
		t.Errorf("Execute = %t, %d; want service-specific 1", spec, code)
	}
}
