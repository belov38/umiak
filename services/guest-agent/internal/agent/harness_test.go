package agent

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/quiesce"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

const (
	machineA = "0192f1a4-7c3e-7b2a-9d4f-1a2b3c4d5e6f"
	machineB = "0192f1a4-7c3e-7b2a-9d4f-aabbccddeeff"
	bootOne  = "11111111-2222-3333-4444-555555555555"
	bootTwo  = "66666666-7777-8888-9999-000000000000"
)

// testBS is the boot secret of the test identities: easy to find in a file.
var testBS = bytes.Repeat([]byte{0x5A}, wire.SecretLen)

// rawFor returns a valid smbios identity of machine id.
func rawFor(id string) ident.Raw {
	return ident.Raw{Serial: wire.SMBIOSSerial(id, testBS), UUID: id}
}

// switchSource is an identity source whose value the test can change.
type switchSource struct {
	mu    sync.Mutex
	raw   ident.Raw
	err   error
	reads int
}

func (s *switchSource) Read(context.Context) (ident.Raw, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	return s.raw, s.err
}

func (s *switchSource) set(raw ident.Raw) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.raw = raw
}

// orderLog records events of several fakes in one order.
type orderLog struct {
	mu    sync.Mutex
	items []string
}

func (o *orderLog) add(item string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.items = append(o.items, item)
}

func (o *orderLog) all() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return slices.Clone(o.items)
}

// fakeDialer counts tunnel dial attempts. Every attempt fails; with block
// set an attempt waits until its context ends.
type fakeDialer struct {
	mu       sync.Mutex
	attempts int
	block    bool
	dialed   chan struct{} // receives one value per attempt (non-blocking)
	order    *orderLog     // gets "dial" per attempt
}

func newFakeDialer(order *orderLog) *fakeDialer {
	return &fakeDialer{dialed: make(chan struct{}, 64), order: order}
}

func (d *fakeDialer) Dial(ctx context.Context, _ transport.Hello) (net.Conn, transport.ConnInfo, error) {
	d.mu.Lock()
	d.attempts++
	block := d.block
	d.mu.Unlock()
	d.order.add("dial")
	select {
	case d.dialed <- struct{}{}:
	default:
	}
	if block {
		<-ctx.Done()
		return nil, transport.ConnInfo{}, ctx.Err()
	}
	return nil, transport.ConnInfo{}, errors.New("test: gateway unreachable")
}

func (d *fakeDialer) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.attempts
}

// notifier records sd_notify states.
type notifier struct {
	order  *orderLog // gets "notify <state>"
	mu     sync.Mutex
	states []string
	ready  chan struct{}
	once   sync.Once
}

func newNotifier(order *orderLog) *notifier {
	return &notifier{order: order, ready: make(chan struct{})}
}

// all returns the states sent so far.
func (n *notifier) all() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return slices.Clone(n.states)
}

func (n *notifier) notify(state string) error {
	n.mu.Lock()
	n.states = append(n.states, state)
	n.mu.Unlock()
	n.order.add("notify " + state)
	if state == "READY=1" {
		n.once.Do(func() { close(n.ready) })
	}
	return nil
}

// harness runs the agent with fakes for every OS-specific part.
type harness struct {
	t        *testing.T
	l        paths.Layout
	cfg      config.Config
	src      *switchSource
	sup      *supervisor.Fake
	resetter *ident.FakeResetter
	dialer   *fakeDialer
	notify   *notifier
	order    *orderLog
	bootID   string
	deps     Deps

	debugListen  string
	debugConfirm bool
	freezer      quiesce.Freezer

	cancel context.CancelFunc
	done   chan error
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	l := paths.ForRoot(t.TempDir())
	cfg := config.Defaults()
	cfg.DockerEnabled = false
	cfg.TunnelURL = "wss://tunnel.test/v1/connect"
	order := &orderLog{}
	h := &harness{
		t:        t,
		order:    order,
		l:        l,
		cfg:      cfg,
		src:      &switchSource{raw: rawFor(machineA)},
		sup:      supervisor.NewFake(l),
		resetter: &ident.FakeResetter{},
		dialer:   newFakeDialer(order),
		notify:   newNotifier(order),
		bootID:   bootOne,
	}
	t.Cleanup(func() { _ = h.sup.Close() })
	return h
}

// seedIdentity records machine id as the applied identity, so the agent
// does not reset the state at its start.
func (h *harness) seedIdentity(id string) {
	h.t.Helper()
	if err := (&ident.File{MachineID: id}).Save(h.l.IdentityFile); err != nil {
		h.t.Fatal(err)
	}
}

// buildDeps returns the fake dependencies of one agent run.
func (h *harness) buildDeps() Deps {
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	return Deps{
		Supervisor:   h.sup,
		IdentSource:  h.src,
		Resetter:     h.resetter,
		Dialer:       h.dialer,
		SdNotify:     h.notify.notify,
		BootID:       func() (string, error) { return h.bootID, nil },
		MountSecrets: func(dir string) error { return os.MkdirAll(dir, 0o755) },
		LookupUser: func(name string) (*process.User, error) {
			return &process.User{Name: name, UID: uid, GID: gid, Home: h.t.TempDir()}, nil
		},
		Statfs:     func(string) (uint64, uint64, error) { return 100 << 30, 50 << 30, nil },
		Hostname:   func() (string, error) { return "sbx-test", nil },
		IdleSample: func() (float64, uint64) { return 0, 0 },
		ShimPath:   "/usr/local/lib/sbx-agent/versions/test/sbx-agent",
		Log:        slog.New(slog.DiscardHandler),

		IdentityRetry: 20 * time.Millisecond,
		StatusEvery:   20 * time.Millisecond,
		DebugListen:   h.debugListen,
		DebugConfirm:  h.debugConfirm,
		Freezer:       h.freezer,
	}
}

// start runs the agent in the background.
func (h *harness) start() {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan error, 1)
	h.notify = newNotifier(h.order)
	deps := h.buildDeps()
	if h.deps.Dialer != nil {
		deps.Dialer = h.deps.Dialer
	}
	go func() { h.done <- Run(ctx, h.l, h.cfg, "1.2.3", deps) }()
	h.t.Cleanup(func() { h.stopQuiet() })
}

// waitReady waits for READY=1.
func (h *harness) waitReady() {
	h.t.Helper()
	select {
	case <-h.notify.ready:
	case err := <-h.done:
		h.t.Fatalf("agent exited before READY=1: %v", err)
	case <-time.After(10 * time.Second):
		h.t.Fatal("no READY=1 within 10s")
	}
}

// stop sends the shutdown and waits for Run to return nil.
func (h *harness) stop() {
	h.t.Helper()
	h.cancel()
	select {
	case err := <-h.done:
		if err != nil {
			h.t.Fatalf("Run returned %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		h.t.Fatal("Run did not return within 10s of the shutdown")
	}
	h.done = nil
}

func (h *harness) stopQuiet() {
	if h.done == nil {
		return
	}
	h.cancel()
	select {
	case err := <-h.done:
		_ = err // the test already failed or does not care
	case <-time.After(10 * time.Second):
	}
	h.done = nil
}

// journal opens state.db after the agent stopped and returns every event.
func (h *harness) journal() []*tunnelv1.Event {
	h.t.Helper()
	st, err := store.Open(h.l.StateDB, store.Options{})
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	evs, err := st.Journal().Read(ctx, 0, 1000)
	if err != nil {
		h.t.Fatalf("read journal: %v", err)
	}
	return evs
}

// types lists the event types in seq order.
func types(evs []*tunnelv1.Event) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.GetType()
	}
	return out
}

// eventually polls cond until it holds or the deadline passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
