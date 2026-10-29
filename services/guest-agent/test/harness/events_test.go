package harness_test

import (
	"testing"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// runToExit starts a command that exits with code at once and waits for its
// command.exited event at the sink.
func runToExit(t *testing.T, e *env, id string, code int32) (*tunnelv1.Event, *agentv1.CommandExited) {
	t.Helper()
	e.sup.Script(id, func(r *supervisor.FakeRun) { _ = r.Exit(code) })
	if _, err := e.process().Start(ctx(t), connect.NewRequest(&agentv1.StartRequest{CommandId: id, Spec: argvSpec("/bin/x")})); err != nil {
		t.Fatalf("Start %s: %v", id, err)
	}
	var ev *tunnelv1.Event
	var msg *agentv1.CommandExited
	eventually(t, "command.exited of "+id, func() bool {
		var ok bool
		ev, ok = e.sink.find(events.TypeCommandExited, func(ev *tunnelv1.Event) bool {
			m := &agentv1.CommandExited{}
			if ev.GetPayload().UnmarshalTo(m) != nil || m.GetCommandId() != id {
				return false
			}
			msg = m
			return true
		})
		return ok
	})
	return ev, msg
}

func TestHarnessEventsDelivered(t *testing.T) {
	e := newEnv(t)
	eventually(t, "agent.started delivered", func() bool {
		_, ok := e.sink.find(events.TypeAgentStarted, nil)
		return ok
	})
	before := e.sink.acked()

	ev1, msg := runToExit(t, e, "ev-1", 7)
	if ev1.GetBootId() != bootID {
		t.Errorf("boot_id %q", ev1.GetBootId())
	}
	if msg.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED || msg.GetCode() != 7 {
		t.Errorf("CommandExited %v", msg)
	}
	if ev1.GetSeq() <= before || e.sink.acked() < ev1.GetSeq() {
		t.Errorf("acked seq %d after command.exited seq %d (before %d)", e.sink.acked(), ev1.GetSeq(), before)
	}

	// The gateway acknowledges a batch before it delivers the next one, so
	// once a later event arrived the agent has applied the ack of ev1.
	ev2, _ := runToExit(t, e, "ev-2", 0)
	if ev2.GetSeq() <= ev1.GetSeq() {
		t.Fatalf("seq %d after %d", ev2.GetSeq(), ev1.GetSeq())
	}
	applied := ev1.GetSeq()

	mark := e.sink.count()
	e.restartAgent()
	eventually(t, "agent.started of the restarted agent", func() bool {
		for _, ev := range e.sink.since(mark) {
			if ev.GetType() == events.TypeAgentStarted {
				return true
			}
		}
		return false
	})
	for _, ev := range e.sink.since(mark) {
		if ev.GetSeq() <= applied {
			t.Errorf("redelivered %s seq %d at or below the applied ack %d", ev.GetType(), ev.GetSeq(), applied)
		}
	}
}
