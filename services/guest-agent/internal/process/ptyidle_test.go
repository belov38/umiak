package process

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/events"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
)

func TestPTYIdleKills(t *testing.T) {
	t.Run("never attached", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.PTYIdle = 100 * time.Millisecond })
		h.start("c1", ptySpec())
		eventually(t, "idle kill", func() bool { return len(h.run("c1").Kills()) > 0 })
		k := h.run("c1").Kills()[0]
		if k.FirstSignal != sigHUP || k.Reason != shimproto.ReasonPTYIdle || k.GraceMs != 50 {
			t.Fatalf("kill %+v, want SIGHUP PTY_IDLE grace 50", k)
		}
		info := h.waitExited("c1")
		if info.GetExit().GetReason() != agentv1.ExitReason_EXIT_REASON_PTY_IDLE {
			t.Fatalf("exit %v", info.GetExit())
		}
		closed := h.rec.Of(events.TypePtyClosed)
		if len(closed) != 1 || closed[0].(*agentv1.PtyClosed).GetReason() != agentv1.ExitReason_EXIT_REASON_PTY_IDLE {
			t.Fatalf("pty.closed %v", closed)
		}
	})
	t.Run("attached, then detached", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.PTYIdle = 300 * time.Millisecond })
		h.start("c1", ptySpec())
		actx, detach := context.WithCancel(t.Context())
		defer detach()
		// The response headers come with the first event, so the client
		// call blocks while the PTY is silent.
		go func() {
			if s, err := h.client.Attach(actx, connect.NewRequest(&agentv1.AttachRequest{CommandId: "c1"})); err == nil {
				for s.Receive() {
				}
			}
		}()
		eventually(t, "attach counted", func() bool {
			_, _, a := h.m.Counts()
			return a == 1
		})
		time.Sleep(600 * time.Millisecond)
		if n := len(h.run("c1").Kills()); n != 0 {
			t.Fatalf("kills with an attach open: %d", n)
		}
		detach()
		eventually(t, "detached at recorded", func() bool {
			rec, _, _ := h.st.GetCommand("c1")
			return rec != nil && rec.PTYDetachedAt != nil
		})
		detached := time.Now()
		eventually(t, "idle kill after detach", func() bool { return len(h.run("c1").Kills()) > 0 })
		if d := time.Since(detached); d < 200*time.Millisecond {
			t.Fatalf("killed %v after detach, want about 300ms", d)
		}
	})
	t.Run("non-pty commands have no idle timer", func(t *testing.T) {
		h := newHarness(t, func(o *Options) { o.PTYIdle = 50 * time.Millisecond })
		h.start("c1", argvSpec("/bin/sleep", "100"))
		time.Sleep(200 * time.Millisecond)
		if n := len(h.run("c1").Kills()); n != 0 {
			t.Fatalf("kills = %d", n)
		}
	})
}
