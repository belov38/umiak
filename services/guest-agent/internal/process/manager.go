// Package process runs and tracks commands (spec sections 9 and 10): the
// umiak.agent.v1.Process Connect service, the durable command records, one
// monitor per live shim, Attach over the output logs, recovery after an
// agent restart or a reboot, and the PTY idle timeout.
//
// A command's durable state is its record in the store; its live state
// (unit alive, attach count, the shim connection) is kept in memory and
// rebuilt by Recover. The shim owns the process, the logs and exit.json, so
// the agent can restart at any time without losing a command.
package process

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"sync"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/errs"
	"github.com/belov38/umiak/services/guest-agent/internal/events"
	"github.com/belov38/umiak/services/guest-agent/internal/output"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/shim"
	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
	"github.com/belov38/umiak/services/guest-agent/internal/store"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

// Command record states (store.Command.State).
const (
	StateStarting = "STARTING"
	StateRunning  = "RUNNING"
	StateExited   = "EXITED"
)

// Exit statuses of a record (store.ExitRecord.Status); reasons use the
// names of agentv1.ExitReason without the prefix ("SHIM_LOST").
const (
	statusExited = "EXITED"
	statusKilled = "KILLED"
	statusLost   = "LOST"

	reasonReboot   = "REBOOT"
	reasonShimLost = "SHIM_LOST"
)

// Defaults of Options.
const (
	DefaultPTYIdle        = 10 * time.Minute
	DefaultPTYHangupGrace = 10 * time.Second
	DefaultPoll           = 250 * time.Millisecond
	DefaultHeartbeat      = 15 * time.Second
	DefaultDurableTimeout = 30 * time.Second
	// DefaultStartingTTL is how long a STARTING record that was never
	// launched waits for a retry of Start before it ends as START_FAILED.
	DefaultStartingTTL = 24 * time.Hour
)

// Limits of the API.
const (
	// DefaultKillGraceMs is the grace of Kill without grace_ms.
	DefaultKillGraceMs = 10000
	// MaxInputBytes is the largest SendInput data. A shim frame holds at
	// most 1 MiB of JSON with the data in base64, and one seq must reach
	// the shim in one frame to stay atomic, so larger input is refused
	// instead of split.
	MaxInputBytes = 512 << 10
	// DefaultPageSize and MaxPageSize bound List pages.
	DefaultPageSize = 100
	MaxPageSize     = 1000
	// maxIDLen keeps "umiak-cmd-<id>.service" within the 255-byte unit name
	// limit of systemd.
	maxIDLen = 255 - len("umiak-cmd-") - len(".service")
)

// Timeouts of calls to a shim made by the agent itself.
const (
	dialTimeout = 2 * time.Second
	shimTimeout = 5 * time.Second
)

// EnvBuilder builds the complete environment of a command (spec 8.2).
type EnvBuilder interface {
	Build(u *User, spec *agentv1.CommandSpec) []string
}

// Options configures a Manager.
type Options struct {
	// Store holds the command records.
	Store *store.Store
	// Supervisor starts and inspects the shim units.
	Supervisor supervisor.Supervisor
	// Layout locates command directories, specs and sockets.
	Layout paths.Layout
	// Config supplies the default user and max_running_commands.
	Config config.Config
	// Emit receives command.exited and pty.closed.
	Emit events.Emitter
	// Env builds command environments.
	Env EnvBuilder
	// ShimPath is the agent binary that runs as the shim.
	ShimPath string
	// AgentVersion is recorded with every command.
	AgentVersion string
	// BootID is the current boot; records of another boot are lost.
	BootID string
	// Output reads the retention state of the logs. Default output.Default().
	Output output.Store
	// Now is the clock. Default time.Now.
	Now func() time.Time
	// PTYIdle closes a PTY command after this long without an attach.
	PTYIdle time.Duration
	// PTYHangupGrace is the time between SIGHUP and the cgroup kill of an
	// idle PTY command.
	PTYHangupGrace time.Duration
	// Poll is the fallback wake-up interval of Attach and the retry
	// interval of the shim monitor.
	Poll time.Duration
	// Heartbeat is the silence after which Attach sends a heartbeat.
	Heartbeat time.Duration
	// DurableTimeout bounds a durable write made for an RPC.
	DurableTimeout time.Duration
	// StartingTTL ends a STARTING record that was never launched (no unit,
	// no shim.json) once it is older than this. Default DefaultStartingTTL.
	StartingTTL time.Duration
	// WaitSecrets, if set, runs with the spec before a command is launched
	// for the first time; an error refuses the Start (claim.Manager
	// WaitSecrets: up to 30 s for pending secrets on Windows, S9 spec 12.8;
	// the Windows boot gate).
	WaitSecrets func(ctx context.Context, spec *agentv1.CommandSpec) error
	// HandlerOptions are added to the Connect handler; the wiring passes
	// reqcache.Interceptors (created once and shared by all services).
	HandlerOptions []connect.HandlerOption
	// Log receives monitor failures. Default slog.Default().
	Log *slog.Logger
}

func (o *Options) setDefaults() error {
	switch {
	case o.Store == nil:
		return errors.New("process: Options.Store is required")
	case o.Supervisor == nil:
		return errors.New("process: Options.Supervisor is required")
	case o.Env == nil:
		return errors.New("process: Options.Env is required")
	case o.ShimPath == "":
		return errors.New("process: Options.ShimPath is required")
	}
	if o.Emit == nil {
		o.Emit = discard{}
	}
	if o.Output == nil {
		o.Output = output.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.PTYIdle <= 0 {
		o.PTYIdle = DefaultPTYIdle
	}
	if o.PTYHangupGrace <= 0 {
		o.PTYHangupGrace = DefaultPTYHangupGrace
	}
	if o.Poll <= 0 {
		o.Poll = DefaultPoll
	}
	if o.Heartbeat <= 0 {
		o.Heartbeat = DefaultHeartbeat
	}
	if o.DurableTimeout <= 0 {
		o.DurableTimeout = DefaultDurableTimeout
	}
	if o.StartingTTL <= 0 {
		o.StartingTTL = DefaultStartingTTL
	}
	if o.Config.MaxRunningCommands <= 0 {
		o.Config.MaxRunningCommands = config.Defaults().MaxRunningCommands
	}
	if o.Config.DefaultUser == "" {
		o.Config.DefaultUser = config.Defaults().DefaultUser
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return nil
}

type discard struct{}

func (discard) Emit(string, proto.Message) {}

// Manager owns the commands of the agent. Its methods are safe for
// concurrent use.
type Manager struct {
	opts  Options
	st    *store.Store
	sup   supervisor.Supervisor
	log   *slog.Logger
	watch *dirWatcher

	ctx    context.Context // ends with Close
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu     sync.Mutex
	closed bool
	cmds   map[string]*command
}

// command is the live state of one command.
type command struct {
	id string

	// sem serializes Start and every read-modify-write of the record. It is
	// a one-slot semaphore, so a waiter can give up with its context.
	sem chan struct{}

	// Guarded by Manager.mu.
	pty        bool
	unitAlive  bool // the unit runs: main process or leftovers
	mainAlive  bool // the main process runs or is being started
	leftovers  bool
	attaches   int
	detachedAt time.Time // last detach of a PTY command; zero while attached
	client     *shimproto.Client
	outdated   bool
	monitoring bool
	syncing    bool // a syncDetached write is queued
	idle       *time.Timer
	idleGen    uint64        // identifies the armed idle timer
	wake       chan struct{} // closed and replaced on every change
}

// lock takes the record lock of c or gives up when ctx ends.
func (c *command) lock(ctx context.Context) error {
	select {
	case c.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// unlock releases the record lock of c.
func (c *command) unlock() { <-c.sem }

// New returns a Manager. Call Recover before serving requests.
func New(opts Options) (*Manager, error) {
	if err := opts.setDefaults(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		opts:   opts,
		st:     opts.Store,
		sup:    opts.Supervisor,
		log:    opts.Log,
		ctx:    ctx,
		cancel: cancel,
		cmds:   make(map[string]*command),
	}
	w, err := newDirWatcher(m.wakeID)
	if err != nil {
		// Attach still works through polling.
		m.log.Warn("process: fsnotify unavailable, attach falls back to polling", "err", err)
	}
	m.watch = w
	return m, nil
}

// Close stops the monitors, timers and attach streams. Commands keep
// running in their units.
func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	for _, c := range m.cmds {
		if c.idle != nil {
			c.idle.Stop()
			c.idle = nil
		}
	}
	m.mu.Unlock()
	m.cancel()
	if m.watch != nil {
		m.watch.close()
	}
	m.wg.Wait()
	return nil
}

// entry returns the live state of id, creating it.
func (m *Manager) entry(id string) *command {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.cmds[id]
	if c == nil {
		c = &command{id: id, sem: make(chan struct{}, 1), wake: make(chan struct{})}
		m.cmds[id] = c
	}
	return c
}

// lockEntry returns the live entry of id with its record lock held. An
// entry that its previous holder forgot while we waited (refused or failed
// Start, Remove) is dropped for a fresh one, so nobody acts on an entry
// outside m.cmds.
func (m *Manager) lockEntry(ctx context.Context, id string) (*command, error) {
	for {
		c := m.entry(id)
		if err := c.lock(ctx); err != nil {
			return nil, err
		}
		if m.current(c) {
			return c, nil
		}
		c.unlock()
	}
}

// lockLive takes the record lock of c for a background caller. It fails
// when the manager closes or c was forgotten meanwhile.
func (m *Manager) lockLive(c *command) bool {
	if c.lock(m.ctx) != nil {
		return false
	}
	if !m.current(c) {
		c.unlock()
		return false
	}
	return true
}

// current reports whether c is the live entry of its id.
func (m *Manager) current(c *command) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cmds[c.id] == c
}

// lockRPC is lockEntry for a handler: the wait is bounded like a durable
// write, and a wait cut short during a freeze answers quiesced.
func (m *Manager) lockRPC(ctx context.Context, id string) (*command, error) {
	lctx, cancel := m.durableCtx(ctx)
	defer cancel()
	c, err := m.lockEntry(lctx, id)
	if err != nil {
		if m.st.Frozen() {
			return nil, storeError(store.ErrFrozen)
		}
		return nil, storeError(err)
	}
	return c, nil
}

// lookup returns the live state of id or nil.
func (m *Manager) lookup(id string) *command {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cmds[id]
}

// forget drops the live state of id.
func (m *Manager) forget(c *command) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmds[c.id] == c {
		delete(m.cmds, c.id)
	}
	if c.idle != nil {
		c.idle.Stop()
		c.idle = nil
	}
	m.notifyLocked(c)
}

// notifyLocked wakes everyone waiting on c. m.mu is held.
func (m *Manager) notifyLocked(c *command) {
	close(c.wake)
	c.wake = make(chan struct{})
}

// wakeID wakes the waiters of command id (fsnotify callback).
func (m *Manager) wakeID(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c := m.cmds[id]; c != nil {
		m.notifyLocked(c)
	}
}

// Counts reports the commands whose unit is alive (main process or
// leftovers), the live PTY commands and the open attach streams.
func (m *Manager) Counts() (running, ptys, attaches int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.cmds {
		if c.unitAlive || c.mainAlive {
			running++
		}
		if c.pty && c.mainAlive {
			ptys++
		}
		attaches += c.attaches
	}
	return running, ptys, attaches
}

// runningMainLocked counts the commands with a live (or starting) main
// process, the measure of max_running_commands. m.mu is held.
func (m *Manager) runningMainLocked() int {
	n := 0
	for _, c := range m.cmds {
		if c.mainAlive {
			n++
		}
	}
	return n
}

// JanitorCommands lists the commands for the output janitor, oldest first.
// On the way it ends the STARTING records whose start was never retried
// within StartingTTL (see expireStarting).
func (m *Manager) JanitorCommands() []output.JanitorCommand {
	recs := m.listRecords()
	if m.expireStarting(recs) > 0 {
		recs = m.listRecords()
	}
	slices.SortStableFunc(recs, func(a, b *store.Command) int { return a.CreatedAt.Compare(b.CreatedAt) })
	out := make([]output.JanitorCommand, 0, len(recs))
	for _, r := range recs {
		jc := output.JanitorCommand{ID: r.ID, Streams: streamNames(r.PTY)}
		if r.State == StateExited {
			jc.Exited = true
			jc.EndedAt = r.EndedAt
		}
		out = append(out, jc)
	}
	return out
}

// listRecords returns every command record; a failed listing is logged and
// returns what was read.
func (m *Manager) listRecords() []*store.Command {
	var recs []*store.Command
	if err := m.st.ListCommands(func(c *store.Command) bool {
		recs = append(recs, c)
		return true
	}); err != nil {
		m.log.Warn("process: list commands", "err", err)
	}
	return recs
}

// RemoveRecord deletes the record and the log directory of an exited
// command for the janitor. Both go under the record lock, so a new command
// with the same id never loses its logs.
func (m *Manager) RemoveRecord(id string) error {
	c, err := m.lockEntry(m.ctx, id)
	if err != nil {
		return err
	}
	defer c.unlock()
	rec, ok, err := m.st.GetCommand(id)
	if err != nil {
		return err
	}
	if !ok {
		m.forget(c)
		return nil
	}
	if rec.State != StateExited {
		return fmt.Errorf("process: command %s is running", id)
	}
	alive, err := m.unitStillAlive(m.ctx, c)
	if err != nil {
		return err
	}
	if alive {
		return fmt.Errorf("process: leftovers of command %s still run", id)
	}
	m.releaseUnit(m.ctx, id)
	if err := m.st.DeleteCommand(m.ctx, id); err != nil {
		return err
	}
	m.forget(c)
	return os.RemoveAll(m.opts.Layout.CommandDir(id))
}

// UnitAlive reports whether the unit of command id still runs (main process
// or leftovers), as Counts counts it. It is the running filter of
// update.ShimVersions: only the shims of such commands are alive.
func (m *Manager) UnitAlive(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.cmds[id]
	return ok && (c.unitAlive || c.mainAlive)
}

func (m *Manager) unitAliveOf(c *command) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return c.unitAlive
}

// streamNames returns the log files of a command.
func streamNames(pty bool) []string {
	if pty {
		return []string{shim.PtyFile}
	}
	return []string{shim.StdoutFile, shim.StderrFile}
}

// streamEnum maps a log file name to its Stream.
func streamEnum(name string) agentv1.Stream {
	switch name {
	case shim.StdoutFile:
		return agentv1.Stream_STREAM_STDOUT
	case shim.StderrFile:
		return agentv1.Stream_STREAM_STDERR
	case shim.PtyFile:
		return agentv1.Stream_STREAM_PTY
	default:
		return agentv1.Stream_STREAM_UNSPECIFIED
	}
}

// durableCtx bounds a durable write made for an RPC by DurableTimeout and
// ends it a little before the call's own deadline, so a write blocked by a
// freeze is answered with quiesced before the caller gives up.
func (m *Manager) durableCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := m.opts.DurableTimeout
	if dl, ok := ctx.Deadline(); ok {
		budget := time.Until(dl)
		timeout = min(timeout, budget-min(budget/10, time.Second))
	}
	return context.WithTimeout(ctx, timeout)
}

// storeError maps a failed durable write of an RPC.
func storeError(err error) error {
	switch {
	case errors.Is(err, store.ErrFrozen):
		return errs.New(connect.CodeUnavailable, errs.Quiesced, "the filesystem is quiesced")
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	default:
		return errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
}

// notFound is the error for an unknown command id.
func notFound(id string) error {
	return errs.Newf(connect.CodeNotFound, errs.CommandNotFound, "command %q not found", id)
}

// getRecord returns the record of id or command_not_found.
func (m *Manager) getRecord(id string) (*store.Command, error) {
	rec, ok, err := m.st.GetCommand(id)
	if err != nil {
		return nil, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	if !ok {
		return nil, notFound(id)
	}
	return rec, nil
}

// fileExists reports whether path exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
