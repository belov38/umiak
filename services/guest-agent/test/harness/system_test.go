package harness_test

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
)

func TestHarnessCapabilities(t *testing.T) {
	e := newEnv(t)
	var caps []string
	c := ctx(t)
	eventually(t, "capabilities in tunnel_sessions", func() bool {
		s, err := e.store.Session(c, e.machineID)
		caps = s.Capabilities
		return err == nil && s.CapabilitiesKnown
	})
	for _, want := range []string{"files.archive.v1", "system.activity.v1"} {
		if !slices.Contains(caps, want) {
			t.Errorf("capabilities %v lack %s", caps, want)
		}
	}
	s, _ := e.store.Session(c, e.machineID)
	if s.AgentVersion != agentVersion || s.BootID != bootID {
		t.Errorf("session %+v", s)
	}
}

func TestHarnessQuiesceThaw(t *testing.T) {
	e := newEnv(t)
	// A command that exits on demand, while the store is frozen.
	if _, err := e.process().Start(ctx(t), connect.NewRequest(&agentv1.StartRequest{CommandId: "q-1", Spec: argvSpec("/bin/x")})); err != nil {
		t.Fatal(err)
	}
	eventually(t, "q-1 launched", func() bool { return e.sup.Run("q-1") != nil })

	// Quiesce needs a request id like every mutation.
	qreq := &agentv1.QuiesceRequest{LeaseMs: proto.Uint32(30000), Docker: proto.Bool(false), Fs: proto.Bool(true)}
	if _, err := e.system().Quiesce(ctx(t), connect.NewRequest(qreq)); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("Quiesce without Sbx-Request-Id = %v", err)
	}
	q, err := e.system().Quiesce(ctx(t), withRequestID(connect.NewRequest(qreq), uuid.NewString()))
	if err != nil {
		t.Fatalf("Quiesce: %v", err)
	}
	if q.Msg.GetLeaseId() == "" || !slices.Equal(q.Msg.GetFrozenMounts(), []string{fakeMount}) {
		t.Fatalf("Quiesce = %v", q.Msg)
	}
	info, err := e.system().Info(ctx(t), connect.NewRequest(&agentv1.InfoRequest{}))
	if err != nil {
		t.Fatalf("Info while quiesced: %v", err)
	}
	if info.Msg.GetQuiesce().GetLeaseId() != q.Msg.GetLeaseId() {
		t.Errorf("Info quiesce %v, want lease %s", info.Msg.GetQuiesce(), q.Msg.GetLeaseId())
	}

	// An event of the frozen time waits in memory: nothing reaches the
	// sink until the thaw.
	mark := e.sink.count()
	if err := e.sup.Run("q-1").Exit(4); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if exited := exitedOf(e.sink.since(mark), "q-1"); exited != nil {
		t.Fatalf("command.exited seq %d delivered while frozen", exited.GetSeq())
	}

	thawID := uuid.NewString()
	th, err := e.system().Thaw(ctx(t), withRequestID(connect.NewRequest(&agentv1.ThawRequest{LeaseId: q.Msg.GetLeaseId()}), thawID))
	if err != nil {
		t.Fatalf("Thaw: %v", err)
	}
	if th.Msg.GetAutoThawed() || th.Msg.GetAlreadyThawed() {
		t.Errorf("Thaw = %v", th.Msg)
	}
	// The replay with the same id answers the cached response.
	again, err := e.system().Thaw(ctx(t), withRequestID(connect.NewRequest(&agentv1.ThawRequest{LeaseId: q.Msg.GetLeaseId()}), thawID))
	if err != nil {
		t.Fatalf("replayed Thaw: %v", err)
	}
	if !proto.Equal(again.Msg, th.Msg) {
		t.Errorf("replayed Thaw = %v, want %v", again.Msg, th.Msg)
	}
	if got := fmt.Sprint(e.freezer.log()); got != fmt.Sprint([]string{"freeze " + fakeMount, "thaw " + fakeMount}) {
		t.Errorf("freezer calls %s", got)
	}

	// The journal is flushed after the thaw.
	eventually(t, "command.exited after the thaw", func() bool { return exitedOf(e.sink.since(mark), "q-1") != nil })
	if _, err := e.process().Get(ctx(t), connect.NewRequest(&agentv1.GetRequest{CommandId: "q-1"})); err != nil {
		t.Errorf("Get after thaw: %v", err)
	}
}

// exitedOf returns the command.exited event of id among evs.
func exitedOf(evs []*tunnelv1.Event, id string) *tunnelv1.Event {
	for _, ev := range evs {
		if exitedPayload(ev, id) != nil {
			return ev
		}
	}
	return nil
}
