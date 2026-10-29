package harness_test

import (
	"testing"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// exitedPayload decodes ev as the command.exited of id, or returns nil.
func exitedPayload(ev *tunnelv1.Event, id string) *agentv1.CommandExited {
	if ev.GetType() != events.TypeCommandExited {
		return nil
	}
	m := &agentv1.CommandExited{}
	if ev.GetPayload().UnmarshalTo(m) != nil || m.GetCommandId() != id {
		return nil
	}
	return m
}

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
			msg = exitedPayload(ev, id)
			return msg != nil
		})
		return ok
	})
	return ev, msg
}

// checkExitedOnce verifies that the agent journaled exactly one
// command.exited for id. A marker command exits afterwards: once its event
// is delivered, every earlier journal event was delivered too (one
// machine's events arrive in seq order), so a duplicate exit would be
// visible. Redeliveries of the same seq (an ack lost to a cut) are allowed:
// delivery is at least once, the seq identifies the event.
func (e *env) checkExitedOnce(t *testing.T, id string) {
	t.Helper()
	marker, _ := runToExit(t, e, "marker-"+id, 0)
	seqs := map[uint64]bool{}
	for _, ev := range e.sink.events() {
		if exitedPayload(ev, id) == nil {
			continue
		}
		if ev.GetSeq() > marker.GetSeq() {
			t.Errorf("command.exited of %s at seq %d after the marker's %d", id, ev.GetSeq(), marker.GetSeq())
		}
		seqs[ev.GetSeq()] = true
	}
	if len(seqs) != 1 {
		t.Errorf("command.exited of %s journaled %d times (seqs %v), want once", id, len(seqs), seqs)
	}
}

func TestHarnessEventsDelivered(t *testing.T) {
	e := newEnv(t)
	eventually(t, "agent.started delivered", func() bool {
		_, ok := e.sink.find(events.TypeAgentStarted, nil)
		return ok
	})
	before := e.sink.maxSeq()

	ev1, msg := runToExit(t, e, "ev-1", 7)
	if ev1.GetBootId() != bootID {
		t.Errorf("boot_id %q", ev1.GetBootId())
	}
	if msg.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED || msg.GetCode() != 7 {
		t.Errorf("CommandExited %v", msg)
	}
	if ev1.GetSeq() <= before {
		t.Errorf("command.exited seq %d, not after the earlier events (up to %d)", ev1.GetSeq(), before)
	}

	// The gateway acknowledges a batch before it reads the next one, so
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

func TestHarnessUnackedTailRedelivered(t *testing.T) {
	e := newEnv(t)
	eventually(t, "agent.started delivered", func() bool {
		_, ok := e.sink.find(events.TypeAgentStarted, nil)
		return ok
	})
	// The sink takes the next events but acknowledges only the prefix
	// delivered so far.
	prefix := e.sink.maxSeq()
	e.sink.capAcks(prefix)
	tail, _ := runToExit(t, e, "tail-1", 0)
	if tail.GetSeq() <= prefix {
		t.Fatalf("tail seq %d within the acked prefix %d", tail.GetSeq(), prefix)
	}

	mark := e.sink.count()
	e.restartAgent()
	// The restarted agent sends the unacknowledged tail again, unchanged,
	// and nothing of the acknowledged prefix.
	eventually(t, "the tail redelivered after the restart", func() bool {
		for _, ev := range e.sink.since(mark) {
			if ev.GetSeq() == tail.GetSeq() {
				return true
			}
		}
		return false
	})
	for _, ev := range e.sink.since(mark) {
		if ev.GetSeq() <= prefix {
			t.Errorf("redelivered %s seq %d within the acked prefix %d", ev.GetType(), ev.GetSeq(), prefix)
		}
		if ev.GetSeq() == tail.GetSeq() && exitedPayload(ev, "tail-1") == nil {
			t.Errorf("seq %d redelivered as %s, want the command.exited of tail-1", ev.GetSeq(), ev.GetType())
		}
	}

	// With the cap lifted the tail is acknowledged and stops coming.
	e.sink.capAcks(0)
	e.checkExitedOnce(t, "tail-1")
}
