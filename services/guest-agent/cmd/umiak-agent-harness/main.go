//go:build !windows

// Command umiak-agent-harness runs the real S2 gateway and the real guest
// agent (agent.Run) in one process, for the api integration tests
// (apps/api/test/agent-real.test.ts). It is a test aid and is never
// packaged. It runs on the Unix development hosts only (process groups,
// PTYs and signals in runner.go), so Windows builds leave it out.
//
// Like test/harness, the gateway keeps its registry in the given Postgres
// (the tunnel migrations must be applied) and serves its internal listener
// on loopback; the agent reaches the gateway over an in-memory network
// (memnet) and runs with fake OS dependencies. Unlike test/harness, the
// commands run for real: the fake supervisor's shims are driven by host
// processes (runner.go), so output, exit codes, stdin, PTYs, signals and
// timeouts behave as in a VM, within the limits listed in runner.go.
// The developer's home stays untouched: the home of the commands and of
// the Filesystem API is a scratch directory (runner.go, guard.go).
//
// It registers one machine (tunnel credentials), waits until its session
// serves with known capabilities, prints one JSON line to stdout
//
//	{"internalUrl", "serviceToken", "machineId", "capabilities", "workDir",
//	 "user", "listeningPort"}
//
// and runs until stdin closes or it gets SIGTERM or SIGINT. workDir is a
// scratch directory and the home of the commands; user is the OS account
// commands run as (the current user); listeningPort is the port the fake
// procfs reports as listening.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/ssh"

	"github.com/belov38/umiak/libs/tunnel/gateway"
	"github.com/belov38/umiak/libs/tunnel/registry"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/memnet"
	"github.com/belov38/umiak/libs/tunnel/wire"

	"github.com/belov38/umiak/services/guest-agent/internal/agent"
	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/ident"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/process"
)

const (
	agentVersion = "0.0.1"
	// serveTimeout bounds the start: gateway ready, agent READY=1, session
	// serving with known capabilities.
	serveTimeout = 60 * time.Second
	// stopTimeout bounds each stop step.
	stopTimeout = 10 * time.Second
	// listeningPort is reported by the fake procfs (0.0.0.0:8080).
	listeningPort = 8080
)

// ready is the JSON line printed once the machine serves.
type ready struct {
	InternalURL   string   `json:"internalUrl"`
	ServiceToken  string   `json:"serviceToken"`
	MachineID     string   `json:"machineId"`
	Capabilities  []string `json:"capabilities"`
	WorkDir       string   `json:"workDir"`
	User          string   `json:"user"`
	ListeningPort int      `json:"listeningPort"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "umiak-agent-harness:", err)
		os.Exit(1)
	}
}

func run() error {
	dsn := flag.String("database-url", os.Getenv("UMIAK_HARNESS_DATABASE_URL"),
		"Postgres URL of the tunnel registry (default $UMIAK_HARNESS_DATABASE_URL)")
	token := flag.String("service-token", "", "service token of the caller \"api\" on the internal listener")
	listen := flag.String("listen", "127.0.0.1:0", "address of the gateway internal listener")
	machineID := flag.String("machine-id", "", "machine id (UUID) to register (default a new one)")
	flag.Parse()
	if *dsn == "" || *token == "" {
		return errors.New("-database-url and -service-token are required")
	}
	if *machineID == "" {
		*machineID = uuid.NewString()
	} else if _, err := uuid.Parse(*machineID); err != nil {
		return fmt.Errorf("-machine-id: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		// The parent closes stdin to stop the harness (or dies).
		_, _ = io.Copy(io.Discard, os.Stdin)
		stop()
	}()

	h, err := start(ctx, *dsn, *token, *listen, *machineID)
	if h != nil {
		defer h.close()
	}
	if err != nil {
		return err
	}
	line, err := json.Marshal(h.info)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(os.Stdout, "%s\n", line); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

// harness is the running gateway and agent; close stops them in reverse.
type harness struct {
	info    ready
	cleanup []func()
}

func (h *harness) onClose(f func()) { h.cleanup = append(h.cleanup, f) }

func (h *harness) close() {
	for i := len(h.cleanup) - 1; i >= 0; i-- {
		h.cleanup[i]()
	}
}

// logger discards logs unless UMIAK_HARNESS_LOG is set.
func logger(args ...any) *slog.Logger {
	if os.Getenv("UMIAK_HARNESS_LOG") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})).With(args...)
	}
	return slog.New(slog.DiscardHandler)
}

func start(ctx context.Context, dsn, token, listen, machineID string) (*harness, error) {
	h := &harness{}
	sctx, cancel := context.WithTimeout(ctx, serveTimeout)
	defer cancel()

	pool, err := pgxpool.New(sctx, dsn)
	if err != nil {
		return h, fmt.Errorf("postgres: %w", err)
	}
	h.onClose(pool.Close)
	store := registry.New(pool)

	bs, err := wire.NewSecret()
	if err != nil {
		return h, err
	}
	if err := store.PutCredentials(sctx, machineID, wire.HashSecret(bs)); err != nil {
		return h, fmt.Errorf("put credentials: %w", err)
	}

	m, err := newMachine(h)
	if err != nil {
		return h, err
	}
	mem := memnet.New(memnet.Options{})
	guard := func(next http.Handler) http.Handler {
		return homeGuard{next: next, home: m.realHome, scratch: m.work}
	}
	gw, url, err := startGateway(ctx, h, store, token, listen, guard)
	if err != nil {
		return h, err
	}
	if err := waitFor(sctx, "gateway ready", gw.Ready); err != nil {
		return h, err
	}
	mem.AddGateway("gw", gw.Admitter(), gw.Ready)
	h.onClose(func() { mem.RemoveGateway("gw") })

	if err := m.startAgent(sctx, h, machineID, bs, mem); err != nil {
		return h, err
	}

	var caps []string
	err = waitFor(sctx, "the agent's tunnel session", func() bool {
		if _, ok := gw.Machine(machineID); !ok {
			return false
		}
		s, err := store.Session(sctx, machineID)
		caps = s.Capabilities
		return err == nil && s.State == "connected" && s.CapabilitiesKnown
	})
	if err != nil {
		return h, err
	}
	h.info = ready{
		InternalURL:   url,
		ServiceToken:  token,
		MachineID:     machineID,
		Capabilities:  caps,
		WorkDir:       m.work,
		User:          m.user.Name,
		ListeningPort: listeningPort,
	}
	return h, nil
}

// startGateway runs one gateway with its internal listener on listen,
// behind wrap. It runs until the harness closes, not until ctx (the start
// budget) ends.
func startGateway(ctx context.Context, h *harness, store *registry.Store, token, listen string,
	wrap func(http.Handler) http.Handler,
) (*gateway.Gateway, string, error) {
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", listen)
	if err != nil {
		return nil, "", err
	}
	url := "http://" + ln.Addr().String()
	g, err := gateway.New(gateway.Config{
		InstanceID:    "harness-" + uuid.NewString(),
		InternalURL:   url,
		Store:         store,
		ServiceTokens: gateway.TokenSet{"api": {token}},
		Logger:        logger("component", "gateway"),
	})
	if err != nil {
		_ = ln.Close()
		return nil, "", err
	}
	gctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		_ = g.Run(gctx)
	}()
	srv := gateway.NewInternalServer(wrap(g.InternalHandler()))
	srvDone := make(chan struct{})
	go func() {
		defer close(srvDone)
		_ = srv.Serve(ln)
	}()
	h.onClose(func() {
		cancel()
		wait(runDone)
		_ = srv.Close()
		wait(srvDone)
	})
	return g, url, nil
}

// machine is the guest side: layout, scratch dir, user, supervisor.
type machine struct {
	root   string
	work   string
	layout paths.Layout
	// user is the OS user with its home set to the scratch dir (Deps.LookupUser).
	user *process.User
	// realHome is the user's home on the host; the agent's own lookups
	// (process, files) still see it, see homeGuard and execSupervisor.
	realHome string
	sup      *execSupervisor
}

// newMachine creates the layout in a short temporary root and a fake
// procfs with one listening port. The root is under /tmp: shim sockets are
// <root>/m/run/umiak-agent/cmd/<26-char id>.sock, and darwin limits unix
// socket paths to 104 bytes, too few under its per-user TMPDIR.
func newMachine(h *harness) (*machine, error) {
	base := ""
	if st, err := os.Stat("/tmp"); err == nil && st.IsDir() {
		base = "/tmp"
	}
	root, err := os.MkdirTemp(base, "umiaka")
	if err != nil {
		return nil, err
	}
	h.onClose(func() { _ = os.RemoveAll(root) })
	// The paths the agent reports are real paths (darwin: /tmp is a link).
	if root, err = filepath.EvalSymlinks(root); err != nil {
		return nil, err
	}
	m := &machine{root: root, work: filepath.Join(root, "work"), layout: paths.ForRoot(filepath.Join(root, "m"))}
	if err := os.MkdirAll(m.work, 0o755); err != nil {
		return nil, err
	}
	cu, err := user.Current()
	if err != nil {
		return nil, err
	}
	u, err := process.LookupUser(cu.Username)
	if err != nil {
		return nil, err
	}
	m.realHome = u.Home
	scratchUser := *u
	scratchUser.Home = m.work
	m.user = &scratchUser
	if err := writeProcNet(filepath.Join(root, "proc")); err != nil {
		return nil, err
	}
	m.sup = newExecSupervisor(m.layout, m.realHome, m.work, logger("component", "shim"))
	// Registered before the agent: it runs after the agent stopped.
	h.onClose(func() { _ = m.sup.Close() })
	return m, nil
}

// writeProcNet writes <dir>/net/tcp with one LISTEN socket on
// 0.0.0.0:listeningPort, read by the agent's port scanner.
func writeProcNet(dir string) error {
	if err := os.MkdirAll(filepath.Join(dir, "net"), 0o755); err != nil {
		return err
	}
	tcp := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		fmt.Sprintf("   0: 00000000:%04X 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0\n", listeningPort)
	return os.WriteFile(filepath.Join(dir, "net", "tcp"), []byte(tcp), 0o644)
}

// startAgent runs agent.Run and waits for READY=1 within ctx. The agent
// runs until the harness closes.
func (m *machine) startAgent(ctx context.Context, h *harness, machineID string, bs []byte, mem *memnet.Network) error {
	cfg := config.Defaults()
	cfg.DockerEnabled = false
	cfg.DefaultUser = m.user.Name
	readyCh := make(chan struct{})
	var once sync.Once
	deps := agent.Deps{
		Supervisor:  m.sup,
		IdentSource: ident.Static{Raw: ident.Raw{Serial: wire.SMBIOSSerial(machineID, bs), UUID: machineID}},
		Resetter:    &ident.FakeResetter{OnRegenerate: func() error { return writeHostKey(m.layout.SSHDir) }},
		Dialer:      mem.Dialer(),
		SdNotify: func(state string) error {
			if state == "READY=1" {
				once.Do(func() { close(readyCh) })
			}
			return nil
		},
		BootID:       func() (string, error) { return uuid.NewString(), nil },
		MountSecrets: func(dir string) error { return os.MkdirAll(dir, 0o755) },
		LookupUser:   func(string) (*process.User, error) { return m.user, nil },
		Statfs:       func(string) (uint64, uint64, error) { return 100 << 30, 50 << 30, nil },
		ProcDir:      filepath.Join(m.root, "proc"),
		// Loopback only: interface addresses of a developer machine (VPN,
		// firewalled) may time out instead of refusing.
		LocalAddrs:    func() []netip.Addr { return nil },
		ShimPath:      "/usr/local/lib/umiak-agent/versions/" + agentVersion + "/umiak-agent",
		Hostname:      func() (string, error) { return "umiak-harness", nil },
		IdleSample:    func() (float64, uint64) { return 0, 0 },
		Log:           logger("component", "agent"),
		IdentityRetry: 20 * time.Millisecond,
	}
	actx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	done := make(chan struct{})
	var runErr error
	go func() {
		defer close(done)
		runErr = agent.Run(actx, m.layout, cfg, agentVersion, deps)
	}()
	h.onClose(func() {
		cancel()
		wait(done)
	})
	select {
	case <-readyCh:
		return nil
	case <-done:
		return fmt.Errorf("agent exited before READY=1: %w", runErr)
	case <-ctx.Done():
		return errors.New("no READY=1 from the agent")
	}
}

// writeHostKey writes a fresh ed25519 public host key into dir, as the
// host key regeneration of the identity reset does.
func writeHostKey(dir string) error {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	sp, err := ssh.NewPublicKey(pub)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "ssh_host_ed25519_key.pub"), ssh.MarshalAuthorizedKey(sp), 0o644)
}

// waitFor polls cond every 10 ms until it holds or ctx ends.
func waitFor(ctx context.Context, what string, cond func() bool) error {
	t := time.NewTicker(10 * time.Millisecond)
	defer t.Stop()
	for !cond() {
		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for %s", what)
		case <-t.C:
		}
	}
	return nil
}

// wait waits for done at most stopTimeout.
func wait(done <-chan struct{}) {
	select {
	case <-done:
	case <-time.After(stopTimeout):
	}
}
