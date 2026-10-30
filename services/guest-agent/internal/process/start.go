package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// startFailedCode is the exit code of a command that never started.
const startFailedCode = 127

// errNotLaunched: a STARTING record without any trace of a launch.
var errNotLaunched = errors.New("process: command was never launched")

// Start creates command id from spec and starts it exactly once (spec 9.2).
// A repeat with the same spec returns the current command with created
// false; another spec fails with already_exists.
func (m *Manager) Start(ctx context.Context, id string, spec *agentv1.CommandSpec) (*agentv1.CommandInfo, bool, error) {
	if err := validateID(id); err != nil {
		return nil, false, err
	}
	if err := checkIDForOS(runtime.GOOS, id); err != nil {
		return nil, false, err
	}
	if err := validateSpec(spec); err != nil {
		return nil, false, err
	}
	hash, err := specHash(spec)
	if err != nil {
		return nil, false, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}

	c, err := m.lockRPC(ctx, id)
	if err != nil {
		return nil, false, err
	}
	defer c.unlock()

	rec, ok, err := m.st.GetCommand(id)
	if err != nil {
		return nil, false, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	created := false
	var env []string
	if ok {
		if rec.SpecHash != hash {
			return nil, false, errs.Newf(connect.CodeAlreadyExists, errs.AlreadyExists,
				"command %q exists with another spec", id)
		}
		m.mu.Lock()
		m.loadLiveLocked(c, rec)
		m.mu.Unlock()
		if rec.State != StateStarting {
			return m.info(rec), false, nil
		}
		// A STARTING record: a previous Start may or may not have launched
		// the unit. Settle what is on disk first; launch only without a trace.
		if err := m.settleLocked(ctx, c, rec, true); !errors.Is(err, errNotLaunched) {
			if err != nil {
				return nil, false, err
			}
			return m.currentInfo(id)
		}
		// The retry launches: it takes a slot like a new command.
		m.mu.Lock()
		full := m.runningMainLocked() >= m.opts.Config.MaxRunningCommands
		m.mu.Unlock()
		if full {
			return nil, false, errs.Newf(connect.CodeResourceExhausted, errs.TooManyCommands,
				"at most %d commands may run at once", m.opts.Config.MaxRunningCommands)
		}
	} else {
		rec, env, err = m.create(ctx, c, id, hash, spec)
		if err != nil {
			return nil, false, err
		}
		created = true
	}

	if err := m.launchLocked(ctx, c, rec, spec, env); err != nil {
		return nil, false, err
	}
	// A PTY that nobody attaches to closes PTYIdle after its creation.
	m.mu.Lock()
	m.ensureIdleLocked(c) //nolint:contextcheck // the idle timer outlives the request
	m.mu.Unlock()
	info, _, err := m.currentInfo(id)
	return info, created, err
}

// create checks the user, the spec against the platform and the limit and
// writes the STARTING record. It returns the environment when checking
// the spec already built it (Windows), for the launch to reuse. the record
// lock of c is held.
func (m *Manager) create(ctx context.Context, c *command, id, hash string, spec *agentv1.CommandSpec) (*store.Command, []string, error) {
	u, err := m.lookupUser(spec)
	if err != nil {
		return nil, nil, err
	}
	env, err := m.prepareSpec(u, spec)
	if err != nil {
		return nil, nil, err
	}
	// Reserve a slot: mainAlive counts toward max_running_commands from
	// here on, so concurrent Starts cannot overshoot the limit.
	m.mu.Lock()
	if m.runningMainLocked() >= m.opts.Config.MaxRunningCommands {
		m.mu.Unlock()
		m.dropIfUnused(c)
		return nil, nil, errs.Newf(connect.CodeResourceExhausted, errs.TooManyCommands,
			"at most %d commands may run at once", m.opts.Config.MaxRunningCommands)
	}
	c.mainAlive = true
	c.pty = spec.GetPty() != nil
	m.mu.Unlock()

	stored, keys, err := storedSpec(spec)
	if err != nil {
		m.release(c)
		return nil, nil, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	now := m.opts.Now().UTC()
	rec := &store.Command{
		ID:           id,
		SpecHash:     hash,
		Spec:         stored,
		EnvKeys:      keys,
		State:        StateStarting,
		BootID:       m.opts.BootID,
		CreatedAt:    now,
		Tags:         spec.GetTags(),
		PTY:          spec.GetPty() != nil,
		AgentVersion: m.opts.AgentVersion,
	}
	if rec.PTY {
		// A PTY that is never attached closes PTYIdle after its creation,
		// also across an agent restart; the first attach clears this.
		rec.PTYDetachedAt = &now
	}
	dctx, cancel := m.durableCtx(ctx)
	defer cancel()
	if err := m.st.PutCommand(dctx, rec); err != nil {
		m.release(c)
		return nil, nil, storeError(err)
	}
	m.mu.Lock()
	m.loadLiveLocked(c, rec)
	m.mu.Unlock()
	return rec, env, nil
}

// release undoes the slot reservation of a Start that wrote no record.
func (m *Manager) release(c *command) {
	m.mu.Lock()
	c.mainAlive = false
	m.mu.Unlock()
	m.dropIfUnused(c)
}

// dropIfUnused forgets c when it has no record.
func (m *Manager) dropIfUnused(c *command) {
	if _, ok, err := m.st.GetCommand(c.id); err == nil && !ok {
		m.forget(c)
	}
}

// loadLiveLocked copies the PTY flag and the recorded detach time of rec
// into the live state of c. m.mu is held.
func (m *Manager) loadLiveLocked(c *command, rec *store.Command) {
	c.pty = rec.PTY
	if c.attaches == 0 && rec.PTYDetachedAt != nil {
		c.detachedAt = *rec.PTYDetachedAt
	}
}

func (m *Manager) setPTY(c *command, pty bool) {
	m.mu.Lock()
	c.pty = pty
	m.mu.Unlock()
}

// launchLocked hands the shim its spec, starts the unit and records the
// outcome. env is the command environment when create built it, else nil.
// the record lock of c is held and rec is STARTING without a trace of a launch.
func (m *Manager) launchLocked(ctx context.Context, c *command, rec *store.Command, spec *agentv1.CommandSpec, env []string) error {
	m.mu.Lock()
	c.mainAlive, c.unitAlive = true, true
	m.mu.Unlock()

	ss, err := m.shimSpec(rec.ID, spec, env)
	if err != nil {
		// The user vanished between two Starts of a STARTING record: the
		// command cannot start (spec 9.2).
		return m.startFailedLocked(ctx, c, err.Error())
	}
	lerr, err := m.launchShim(ctx, rec.ID, ss)
	if err != nil {
		return m.abortLaunch(c, err)
	}

	switch {
	case lerr == nil, errors.Is(lerr, supervisor.ErrUnitExists):
	case ctx.Err() != nil:
		// The unit may still start: let the monitor find out.
		m.startMonitor(c) //nolint:contextcheck // the monitor outlives the request
		return storeError(ctx.Err())
	default:
		if fileExists(m.cmdPath(rec.ID, shim.ExitJSON)) || fileExists(m.cmdPath(rec.ID, shim.ShimJSON)) {
			break
		}
		m.log.Warn("process: launch failed", "id", rec.ID, "err", lerr)
		return m.startFailedLocked(ctx, c, lerr.Error())
	}

	if !fileExists(m.cmdPath(rec.ID, shim.ExitJSON)) {
		var sf shim.ShimFile
		if err := fsutil.ReadJSON(m.cmdPath(rec.ID, shim.ShimJSON), &sf); err == nil && sf.Pid > 0 {
			dctx, cancel := m.durableCtx(ctx)
			err := m.markRunningLocked(dctx, c, sf.Pid, sf)
			cancel()
			if err != nil {
				m.startMonitor(c) //nolint:contextcheck // the monitor outlives the request
				return storeError(err)
			}
		}
	}
	err = m.settleLocked(ctx, c, rec, true)
	if errors.Is(err, errNotLaunched) {
		// Launch returned but the shim left nothing behind.
		return m.startFailedLocked(ctx, c, "the shim did not start")
	}
	return err
}

// launchShim hands ss to the supervisor and starts the shim: over the
// launch itself when the supervisor implements SpecLauncher (Windows),
// else through the CmdSpec file, which is removed afterwards. err is a
// failure before the supervisor was called; lerr is the launch result.
func (m *Manager) launchShim(ctx context.Context, id string, ss shim.Spec) (lerr, err error) {
	if sl, ok := m.sup.(supervisor.SpecLauncher); ok {
		data, err := json.Marshal(ss)
		if err != nil {
			return nil, err
		}
		// The spec holds the environment.
		defer clear(data)
		return sl.LaunchSpec(ctx, id, m.opts.ShimPath, nil, data), nil
	}
	specPath := m.opts.Layout.CmdSpec(id)
	if err := os.MkdirAll(m.opts.Layout.CmdSpecDir, 0o700); err != nil {
		return nil, err
	}
	if err := fsutil.WriteJSONAtomic(specPath, ss, 0o600); err != nil {
		return nil, err
	}
	lerr = m.sup.Launch(ctx, id, m.opts.ShimPath, nil)
	// The spec holds the environment: never leave it behind. A shim that
	// has not read it yet fails before shim.json, which is "not launched".
	if err := os.Remove(specPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		m.log.Warn("process: remove command spec", "id", id, "err", err)
	}
	return lerr, nil
}

// abortLaunch undoes the live state of a launch that never reached the
// supervisor; the record stays STARTING, so a retry launches.
func (m *Manager) abortLaunch(c *command, err error) error {
	m.mu.Lock()
	c.mainAlive, c.unitAlive = false, false
	m.mu.Unlock()
	return errs.New(connect.CodeInternal, errs.Internal, err.Error())
}

// startFailedLocked records a command that could not start: EXITED with
// START_FAILED and code 127, the message in its last stream so attach shows
// it (spec 9.2). the record lock of c is held.
func (m *Manager) startFailedLocked(ctx context.Context, c *command, msg string) error {
	return m.recordStartFailedLocked(ctx, c, msg, false)
}

// recordStartFailedLocked is startFailedLocked with the event order of
// finalizeLocked: emitFirst for background callers.
func (m *Manager) recordStartFailedLocked(ctx context.Context, c *command, msg string, emitFirst bool) error {
	m.mu.Lock()
	pty := c.pty
	m.mu.Unlock()
	streams := streamNames(pty)
	dir := m.opts.Layout.CommandDir(c.id)
	if err := os.MkdirAll(dir, 0o700); err == nil {
		for _, s := range streams {
			f, err := os.OpenFile(filepath.Join(dir, s), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
			if err != nil {
				continue
			}
			if s == streams[len(streams)-1] {
				_, _ = f.WriteString("sbx-agent: cannot start command: " + msg + "\n")
			}
			_ = f.Close()
		}
	}
	ex := m.currentEnds(c.id, pty)
	ex.status, ex.reason, ex.code = statusExited, shimproto.ReasonStartFailed, startFailedCode
	dctx, cancel := m.durableCtx(ctx)
	defer cancel()
	if err := m.finalizeLocked(dctx, c, ex, emitFirst); err != nil {
		return storeError(err)
	}
	m.markGone(c)
	return nil
}

// currentInfo returns the CommandInfo of id from its record.
func (m *Manager) currentInfo(id string) (*agentv1.CommandInfo, bool, error) {
	rec, err := m.getRecord(id)
	if err != nil {
		return nil, false, err
	}
	return m.info(rec), false, nil
}

// lookupUser resolves the user of spec.
func (m *Manager) lookupUser(spec *agentv1.CommandSpec) (*User, error) {
	name := spec.GetUser()
	if name == "" {
		name = m.opts.Config.DefaultUser
	}
	u, err := LookupUser(name)
	if errors.Is(err, ErrUserNotFound) {
		return nil, errs.Newf(connect.CodeInvalidArgument, errs.UserNotFound, "user %q not found", name)
	}
	if err != nil {
		return nil, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	return u, nil
}

// shimSpec resolves spec into what the shim runs: argv, env, cwd and the
// credentials. env, when not nil, is the already built environment.
func (m *Manager) shimSpec(id string, spec *agentv1.CommandSpec, env []string) (shim.Spec, error) {
	u, err := m.lookupUser(spec)
	if err != nil {
		return shim.Spec{}, err
	}
	cwd, err := resolveCwd(u, spec.GetCwd())
	if err != nil {
		return shim.Spec{}, err
	}
	if env == nil {
		env = m.opts.Env.Build(u, spec)
	}
	var argv []string
	var script string
	if sh, ok := spec.GetCmd().(*agentv1.CommandSpec_Shell); ok {
		login := spec.Login == nil || spec.GetLogin()
		if argv, script, err = m.shellArgv(id, u, sh.Shell, login); err != nil {
			return shim.Spec{}, err
		}
	} else {
		argv = slices.Clone(spec.GetArgv().GetArgs())
	}
	ss := shim.Spec{
		ID:            id,
		Argv:          argv,
		Env:           env,
		Cwd:           cwd,
		UID:           u.UID,
		GID:           u.GID,
		Groups:        u.Groups,
		Stdin:         spec.GetStdin(),
		TimeoutMs:     spec.GetTimeoutMs(),
		KillLeftovers: spec.GetOnExit() == agentv1.OnExit_ON_EXIT_KILL_LEFTOVERS,
		AgentVersion:  m.opts.AgentVersion,
		User:          u.Name,
		Desktop:       spec.GetDesktop(),
		Script:        script,
	}
	if u.Windows != nil {
		ss.User = u.Windows.Account
	}
	if p := spec.GetPty(); p != nil {
		ss.PTY = &shim.PTYSpec{Cols: uint16(p.GetCols()), Rows: uint16(p.GetRows()), Term: p.GetTerm()} //nolint:gosec // validated
		if ss.PTY.Cols == 0 {
			ss.PTY.Cols = 80
		}
		if ss.PTY.Rows == 0 {
			ss.PTY.Rows = 24
		}
	}
	return ss, nil
}

// validateID accepts the ids that form a valid unit name and file name.
func validateID(id string) error {
	if id == "" || len(id) > maxIDLen || id == "." || id == ".." {
		return errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, "command_id must be 1..%d bytes of [A-Za-z0-9:_.-]", maxIDLen)
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == ':', c == '_', c == '.', c == '-':
		default:
			return errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, "command_id %q must match [A-Za-z0-9:_.-]", id)
		}
	}
	return nil
}

// checkIDForOS rejects ids a valid command id cannot be on goos: on
// Windows a colon would make the command directory an alternate data
// stream of the commands directory.
func checkIDForOS(goos, id string) error {
	if goos == "windows" && strings.Contains(id, ":") {
		return errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument,
			"command_id %q: ':' is not allowed on windows", id)
	}
	return nil
}

// validateSpec checks the parts of spec the agent relies on.
func validateSpec(spec *agentv1.CommandSpec) error {
	invalid := func(format string, args ...any) error {
		return errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, format, args...)
	}
	if spec == nil {
		return invalid("spec is required")
	}
	switch cmd := spec.GetCmd().(type) {
	case *agentv1.CommandSpec_Argv:
		if len(cmd.Argv.GetArgs()) == 0 || cmd.Argv.GetArgs()[0] == "" {
			return invalid("argv must name a program")
		}
	case *agentv1.CommandSpec_Shell:
		if cmd.Shell == "" {
			return invalid("shell is empty")
		}
	default:
		return invalid("spec needs argv or shell")
	}
	for k := range spec.GetEnv() {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			return invalid("invalid env name %q", k)
		}
	}
	if p := spec.GetPty(); p != nil && (p.GetCols() > math.MaxUint16 || p.GetRows() > math.MaxUint16) {
		return invalid("pty size %dx%d is too large", p.GetCols(), p.GetRows())
	}
	if spec.GetDesktop() {
		// The desktop helper comes with S10 (S9 plan decision 2).
		return errs.New(connect.CodeFailedPrecondition, errs.DesktopNotReady,
			"desktop sessions are not available: the agent has no desktop helper")
	}
	return nil
}

// specHash is the sha256 of the deterministic encoding of the full spec,
// env values included.
func specHash(spec *agentv1.CommandSpec) (string, error) {
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(spec)
	if err != nil {
		return "", fmt.Errorf("process: encode spec: %w", err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// storedSpec returns the spec as stored in the record (protojson, env
// values removed) and the sorted env names.
func storedSpec(spec *agentv1.CommandSpec) (json.RawMessage, []string, error) {
	clean := proto.CloneOf(spec)
	keys := make([]string, 0, len(clean.GetEnv()))
	for k := range clean.GetEnv() {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	clean.Env = nil
	b, err := protojson.Marshal(clean)
	if err != nil {
		return nil, nil, fmt.Errorf("process: encode spec: %w", err)
	}
	return b, keys, nil
}
