package registry_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/belov38/boat-dev-clone/libs/tunnel/internal/pgtest"
	"github.com/belov38/boat-dev-clone/libs/tunnel/registry"
	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
)

func TestMain(m *testing.M) { pgtest.Main(m) }

func hash(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}

func setup(t *testing.T) (*registry.Store, *pgxpool.Pool) {
	t.Helper()
	pool, _ := pgtest.New(t)
	return registry.New(pool), pool
}

// machine creates credentials for a new machine with bootstrap secret "bs-<id>".
func machine(t *testing.T, s *registry.Store) (id string, bs []byte) {
	t.Helper()
	id = uuid.NewString()
	bs = hash("bs-" + id)
	if err := s.PutCredentials(context.Background(), id, bs); err != nil {
		t.Fatalf("PutCredentials: %v", err)
	}
	return id, bs
}

func params(machineID, instanceID string, scheme transport.AuthScheme, secret []byte) registry.AdmitParams {
	return registry.AdmitParams{
		MachineID:       machineID,
		InstanceID:      instanceID,
		ConnID:          "conn-" + uuid.NewString(),
		AgentInstanceID: "agent-" + uuid.NewString(),
		BootID:          "boot",
		Vmgenid:         "vmgen",
		AgentVersion:    "1.0.0",
		ProtoVersion:    "1",
		Scheme:          scheme,
		SecretHash:      secret,
	}
}

func TestMigrationsApply(t *testing.T) {
	_, pool := setup(t)
	ctx := context.Background()
	for _, table := range []string{"gateway_instances", "tunnel_sessions", "tunnel_credentials"} {
		var n int
		err := pool.QueryRow(ctx,
			`SELECT count(*) FROM information_schema.tables WHERE table_schema='tunnel' AND table_name=$1`, table).Scan(&n)
		if err != nil || n != 1 {
			t.Errorf("table tunnel.%s: n=%d err=%v", table, n, err)
		}
	}
	var n int
	err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema='tunnel' AND table_name='gateway_instances' AND column_name='drain_started_at'`).Scan(&n)
	if err != nil || n != 1 {
		t.Errorf("drain_started_at column: n=%d err=%v", n, err)
	}
}

func TestAdmitBootstrap(t *testing.T) {
	s, _ := setup(t)
	ctx := context.Background()
	id, bs := machine(t, s)

	res, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs))
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
	if res.Epoch != 1 || res.Prev != nil {
		t.Fatalf("got epoch=%d prev=%v, want epoch 1 and no prev", res.Epoch, res.Prev)
	}
	sess, err := s.Session(ctx, id)
	if err != nil {
		t.Fatalf("Session: %v", err)
	}
	if sess.State != "connected" || sess.Epoch != 1 || sess.InstanceID != "gw-1" || sess.DisconnectedAt != nil {
		t.Fatalf("unexpected session %+v", sess)
	}

	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, hash("wrong"))); !errors.Is(err, registry.ErrUnauthorized) {
		t.Fatalf("wrong secret: err = %v, want ErrUnauthorized", err)
	}
	if _, err := s.Admit(ctx, params(uuid.NewString(), "gw-1", transport.AuthBootstrap, bs)); !errors.Is(err, registry.ErrUnauthorized) {
		t.Fatalf("unknown machine: err = %v, want ErrUnauthorized", err)
	}
	if _, err := s.Admit(ctx, params("not-a-uuid", "gw-1", transport.AuthBootstrap, bs)); !errors.Is(err, registry.ErrUnauthorized) {
		t.Fatalf("malformed machine id: err = %v, want ErrUnauthorized", err)
	}
	// A failed admit must not touch the session.
	sess, _ = s.Session(ctx, id)
	if sess.Epoch != 1 {
		t.Fatalf("epoch changed by failed admits: %d", sess.Epoch)
	}
}

func TestAdmitIncrementsEpochAndReturnsPrev(t *testing.T) {
	s, _ := setup(t)
	ctx := context.Background()
	id, bs := machine(t, s)

	p1 := params(id, "gw-1", transport.AuthBootstrap, bs)
	if _, err := s.Admit(ctx, p1); err != nil {
		t.Fatal(err)
	}
	p2 := params(id, "gw-2", transport.AuthBootstrap, bs)
	res, err := s.Admit(ctx, p2)
	if err != nil {
		t.Fatal(err)
	}
	if res.Epoch != 2 {
		t.Fatalf("epoch = %d, want 2", res.Epoch)
	}
	if res.Prev == nil || res.Prev.AgentInstanceID != p1.AgentInstanceID || res.Prev.InstanceID != "gw-1" || res.Prev.Epoch != 1 {
		t.Fatalf("prev = %+v, want first session", res.Prev)
	}
	sess, _ := s.Session(ctx, id)
	if sess.InstanceID != "gw-2" || sess.ConnID != p2.ConnID || sess.Epoch != 2 {
		t.Fatalf("session = %+v", sess)
	}
}

func TestAdmitRetired(t *testing.T) {
	s, _ := setup(t)
	ctx := context.Background()
	id, bs := machine(t, s)

	if r, err := s.Retired(ctx, id); err != nil || r {
		t.Fatalf("Retired before = %v, %v", r, err)
	}
	if err := s.Retire(ctx, id); err != nil {
		t.Fatal(err)
	}
	if r, err := s.Retired(ctx, id); err != nil || !r {
		t.Fatalf("Retired after = %v, %v", r, err)
	}
	// Retired is reported before the secret is checked.
	for _, secret := range [][]byte{bs, hash("wrong")} {
		if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, secret)); !errors.Is(err, registry.ErrRetired) {
			t.Fatalf("err = %v, want ErrRetired", err)
		}
	}
}

func TestTokenRotation(t *testing.T) {
	s, _ := setup(t)
	ctx := context.Background()
	id, _ := machine(t, s)
	h0, h1 := hash("mt0"), hash("mt1")

	// First token: begin, then the agent connects with it, which promotes it.
	if err := s.BeginRotation(ctx, id, h0); err != nil {
		t.Fatal(err)
	}
	res, err := s.Admit(ctx, params(id, "gw-1", transport.AuthToken, h0))
	if err != nil {
		t.Fatalf("admit h0: %v", err)
	}
	if res.MTIssuedAt == nil {
		t.Fatal("MTIssuedAt not set after promotion")
	}

	if err := s.BeginRotation(ctx, id, h1); err != nil {
		t.Fatal(err)
	}
	// Both tokens work before the promotion.
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthToken, h0)); err != nil {
		t.Fatalf("h0 before promotion: %v", err)
	}
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthToken, h1)); err != nil {
		t.Fatalf("h1: %v", err)
	}
	// h1 was promoted: h0 is gone.
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthToken, h0)); !errors.Is(err, registry.ErrUnauthorized) {
		t.Fatalf("h0 after promotion: err = %v, want ErrUnauthorized", err)
	}
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthToken, h1)); err != nil {
		t.Fatalf("h1 after promotion: %v", err)
	}
	done, err := s.CompleteRotation(ctx, id, h1)
	if err != nil || done {
		t.Fatalf("CompleteRotation after promotion = %v, %v; want false, nil", done, err)
	}

	// Completing before any connect promotes the pending token.
	h2 := hash("mt2")
	if err := s.BeginRotation(ctx, id, h2); err != nil {
		t.Fatal(err)
	}
	done, err = s.CompleteRotation(ctx, id, h2)
	if err != nil || !done {
		t.Fatalf("CompleteRotation = %v, %v; want true, nil", done, err)
	}
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthToken, h1)); !errors.Is(err, registry.ErrUnauthorized) {
		t.Fatalf("h1 after completion: err = %v, want ErrUnauthorized", err)
	}
	// A bootstrap secret is not accepted as a token and vice versa.
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, h2)); !errors.Is(err, registry.ErrUnauthorized) {
		t.Fatalf("token as bootstrap: err = %v, want ErrUnauthorized", err)
	}
}

func TestDisconnectFencing(t *testing.T) {
	s, _ := setup(t)
	ctx := context.Background()
	id, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Admit(ctx, params(id, "gw-2", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}

	if ok, err := s.Disconnect(ctx, id, "gw-1", 1); err != nil || ok {
		t.Fatalf("stale epoch: %v, %v; want false, nil", ok, err)
	}
	if ok, err := s.Disconnect(ctx, id, "gw-1", 2); err != nil || ok {
		t.Fatalf("wrong instance: %v, %v; want false, nil", ok, err)
	}
	if ok, err := s.Disconnect(ctx, id, "gw-2", 2); err != nil || !ok {
		t.Fatalf("current epoch: %v, %v; want true, nil", ok, err)
	}
	sess, _ := s.Session(ctx, id)
	if sess.State != "disconnected" || sess.DisconnectedAt == nil {
		t.Fatalf("session = %+v", sess)
	}
	if ok, _ := s.Disconnect(ctx, id, "gw-2", 2); ok {
		t.Fatal("second disconnect must be a no-op")
	}
	if ok, _ := s.UpdateSessionInfo(ctx, id, 2, []string{"exec"}); ok {
		t.Fatal("UpdateSessionInfo on a disconnected session must be a no-op")
	}
}

func TestUpdateSessionInfo(t *testing.T) {
	s, _ := setup(t)
	ctx := context.Background()
	id, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.UpdateSessionInfo(ctx, id, 2, []string{"x"}); err != nil || ok {
		t.Fatalf("stale epoch: %v, %v", ok, err)
	}
	if ok, err := s.UpdateSessionInfo(ctx, id, 1, []string{"exec", "files"}); err != nil || !ok {
		t.Fatalf("current epoch: %v, %v", ok, err)
	}
	sess, _ := s.Session(ctx, id)
	if len(sess.Capabilities) != 2 || sess.Capabilities[0] != "exec" {
		t.Fatalf("capabilities = %v", sess.Capabilities)
	}
	if ok, err := s.UpdateSessionInfo(ctx, id, 1, nil); err != nil || !ok {
		t.Fatalf("nil capabilities: %v, %v", ok, err)
	}
	if _, err := s.Session(ctx, uuid.NewString()); !errors.Is(err, registry.ErrNotFound) {
		t.Fatalf("unknown session: err = %v, want ErrNotFound", err)
	}
}

func TestOwnerIgnoresStaleInstance(t *testing.T) {
	s, pool := setup(t)
	ctx := context.Background()
	id, bs := machine(t, s)
	if err := s.RegisterInstance(ctx, "gw-1", "http://10.0.0.1:8080"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}

	o, ok, err := s.Owner(ctx, id, 15*time.Second)
	if err != nil || !ok {
		t.Fatalf("Owner = %+v, %v, %v", o, ok, err)
	}
	if o.InstanceID != "gw-1" || o.InternalURL != "http://10.0.0.1:8080" || o.Epoch != 1 {
		t.Fatalf("owner = %+v", o)
	}

	if _, err := pool.Exec(ctx, `UPDATE tunnel.gateway_instances SET heartbeat_at = now() - interval '20 seconds'`); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Owner(ctx, id, 15*time.Second); err != nil || ok {
		t.Fatalf("stale instance: ok=%v err=%v; want not found", ok, err)
	}

	if err := s.Heartbeat(ctx, "gw-1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.Owner(ctx, id, 15*time.Second); !ok {
		t.Fatal("owner not found after heartbeat")
	}
	if _, err := s.Disconnect(ctx, id, "gw-1", 1); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.Owner(ctx, id, 15*time.Second); ok {
		t.Fatal("disconnected session must have no owner")
	}
	if err := s.Heartbeat(ctx, "gone"); !errors.Is(err, registry.ErrNotFound) {
		t.Fatalf("heartbeat of unknown instance: %v, want ErrNotFound", err)
	}
}

func TestSweepStale(t *testing.T) {
	s, pool := setup(t)
	ctx := context.Background()

	const staleInstances = 6
	want := map[string]string{} // machine id -> instance id
	var stale []string
	for i := range staleInstances {
		inst := "gw-stale-" + string(rune('a'+i))
		stale = append(stale, inst)
		if err := s.RegisterInstance(ctx, inst, "http://x"); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			id, bs := machine(t, s)
			if _, err := s.Admit(ctx, params(id, inst, transport.AuthBootstrap, bs)); err != nil {
				t.Fatal(err)
			}
			want[id] = inst
		}
	}
	// A session of an instance that is not stale and one of self.
	if err := s.RegisterInstance(ctx, "gw-self", "http://self"); err != nil {
		t.Fatal(err)
	}
	selfMachine, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(selfMachine, "gw-self", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}

	// An already disconnected session of a stale instance stays untouched.
	oldID, oldBS := machine(t, s)
	if _, err := s.Admit(ctx, params(oldID, stale[0], transport.AuthBootstrap, oldBS)); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Disconnect(ctx, oldID, stale[0], 1); err != nil || !ok {
		t.Fatal(ok, err)
	}
	oldBefore, _ := s.Session(ctx, oldID)

	if _, err := pool.Exec(ctx,
		`UPDATE tunnel.gateway_instances SET heartbeat_at = now() - interval '30 seconds' WHERE id = ANY($1)`, stale); err != nil {
		t.Fatal(err)
	}
	// Self is stale as well but must never be swept.
	if _, err := pool.Exec(ctx,
		`UPDATE tunnel.gateway_instances SET heartbeat_at = now() - interval '60 seconds' WHERE id = 'gw-self'`); err != nil {
		t.Fatal(err)
	}
	heartbeats := map[string]time.Time{}
	rows, err := pool.Query(ctx, `SELECT id, heartbeat_at FROM tunnel.gateway_instances`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		var ts time.Time
		if err := rows.Scan(&id, &ts); err != nil {
			t.Fatal(err)
		}
		heartbeats[id] = ts
	}
	rows.Close()

	var (
		wg      sync.WaitGroup
		results [2][]registry.Swept
		errs    [2]error
		start   = make(chan struct{})
	)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results[i], errs[i] = s.SweepStale(ctx, "gw-self", 15*time.Second)
		}()
	}
	close(start)
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	got := map[string]registry.Swept{}
	for _, r := range results {
		for _, sw := range r {
			if _, dup := got[sw.MachineID]; dup {
				t.Fatalf("machine %s swept by both sweepers", sw.MachineID)
			}
			got[sw.MachineID] = sw
		}
	}
	if len(got) != len(want) {
		t.Fatalf("swept %d sessions, want %d", len(got), len(want))
	}
	for id, inst := range want {
		sw, ok := got[id]
		if !ok {
			t.Fatalf("machine %s not swept", id)
		}
		if sw.InstanceID != inst || sw.Epoch != 1 || !sw.DisconnectedAt.Equal(heartbeats[inst]) {
			t.Fatalf("swept = %+v, want instance %s heartbeat %v", sw, inst, heartbeats[inst])
		}
		sess, _ := s.Session(ctx, id)
		if sess.State != "disconnected" || sess.DisconnectedAt == nil || !sess.DisconnectedAt.Equal(heartbeats[inst]) {
			t.Fatalf("session %s = %+v", id, sess)
		}
		if sw.AgentInstanceID == "" || sw.AgentInstanceID != sess.AgentInstanceID {
			t.Fatalf("swept agent instance id %q, session has %q", sw.AgentInstanceID, sess.AgentInstanceID)
		}
	}
	for _, inst := range stale {
		if _, err := s.Instance(ctx, inst); !errors.Is(err, registry.ErrNotFound) {
			t.Fatalf("instance %s: err = %v, want ErrNotFound", inst, err)
		}
	}
	if _, err := s.Instance(ctx, "gw-self"); err != nil {
		t.Fatalf("self was swept: %v", err)
	}
	if sess, _ := s.Session(ctx, selfMachine); sess.State != "connected" {
		t.Fatalf("self session = %+v", sess)
	}
	if oldAfter, _ := s.Session(ctx, oldID); !oldAfter.DisconnectedAt.Equal(*oldBefore.DisconnectedAt) {
		t.Fatalf("already disconnected session changed: %+v -> %+v", oldBefore, oldAfter)
	}

	again, err := s.SweepStale(ctx, "gw-self", 15*time.Second)
	if err != nil || len(again) != 0 {
		t.Fatalf("second sweep = %v, %v; want nothing", again, err)
	}
}

// events collects Listen callbacks.
type events struct {
	session  chan string
	instance chan string
}

func newEvents() *events {
	return &events{session: make(chan string, 64), instance: make(chan string, 64)}
}

func (e *events) handlers() registry.ListenHandlers {
	return registry.ListenHandlers{
		Session:  func(id string) { e.session <- id },
		Instance: func(id string) { e.instance <- id },
	}
}

func expect(t *testing.T, ch <-chan string, want, what string) {
	t.Helper()
	select {
	case got := <-ch:
		if got != want {
			t.Fatalf("%s: got %q, want %q", what, got, want)
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("%s: timeout waiting for %q", what, want)
	}
}

func drain(ch <-chan string) {
	for {
		select {
		case <-ch:
		case <-time.After(200 * time.Millisecond):
			return
		}
	}
}

func TestListenNotifies(t *testing.T) {
	s, pool := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	ev := newEvents()
	done := make(chan error, 1)
	go func() { done <- s.Listen(ctx, ev.handlers()) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("Listen returned %v, want context.Canceled", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("Listen did not return after cancel")
		}
	})

	// The first LISTEN is followed by a resync call on both handlers.
	expect(t, ev.session, "", "initial session resync")
	expect(t, ev.instance, "", "initial instance resync")

	id, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.session, id, "admit")
	if ok, err := s.UpdateSessionInfo(ctx, id, 1, []string{"exec"}); err != nil || !ok {
		t.Fatal(ok, err)
	}
	expect(t, ev.session, id, "update session info")
	if err := s.Retire(ctx, id); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.session, id, "retire")

	if err := s.RegisterInstance(ctx, "gw-1", "http://x"); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.instance, "gw-1", "register instance")
	if err := s.SetInstanceState(ctx, "gw-1", "draining"); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.instance, "gw-1", "draining")
	inst, err := s.Instance(ctx, "gw-1")
	if err != nil || inst.State != "draining" || inst.DrainStartedAt == nil {
		t.Fatalf("instance = %+v, %v", inst, err)
	}
	first := *inst.DrainStartedAt
	time.Sleep(10 * time.Millisecond)
	if err := s.SetInstanceState(ctx, "gw-1", "draining"); err != nil {
		t.Fatal(err)
	}
	if inst, _ = s.Instance(ctx, "gw-1"); !inst.DrainStartedAt.Equal(first) {
		t.Fatal("drain_started_at must be set once")
	}
	drain(ev.instance)
	if err := s.Heartbeat(ctx, "gw-1"); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-ev.instance:
		t.Fatalf("heartbeat produced a notification: %q", got)
	case <-time.After(300 * time.Millisecond):
	}
	if err := s.DeleteInstance(ctx, "gw-1"); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.instance, "gw-1", "delete instance")
	if _, err := s.Instance(ctx, "gw-1"); !errors.Is(err, registry.ErrNotFound) {
		t.Fatalf("after delete: err = %v, want ErrNotFound", err)
	}

	// Kill the listener backend: both handlers get a resync after reconnect,
	// then notifications resume.
	drain(ev.session)
	drain(ev.instance)
	var killed int
	err = pool.QueryRow(ctx, `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
		WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE 'listen %'`).Scan(&killed)
	if err != nil || killed != 1 {
		t.Fatalf("terminate listener: killed=%d err=%v", killed, err)
	}
	expect(t, ev.session, "", "session resync after reconnect")
	expect(t, ev.instance, "", "instance resync after reconnect")

	id2, bs2 := machine(t, s)
	if _, err := s.Admit(ctx, params(id2, "gw-1", transport.AuthBootstrap, bs2)); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.session, id2, "admit after reconnect")
	if err := s.RegisterInstance(ctx, "gw-2", "http://y"); err != nil {
		t.Fatal(err)
	}
	expect(t, ev.instance, "gw-2", "register after reconnect")
}

func TestListenNilHandlersAndCancel(t *testing.T) {
	s, _ := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Listen(ctx, registry.ListenHandlers{}) }()
	id, bs := machine(t, s)
	if _, err := s.Admit(ctx, params(id, "gw-1", transport.AuthBootstrap, bs)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Listen returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Listen did not return")
	}
}
