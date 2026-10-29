package process

import (
	"context"
	"errors"
	"math"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// SendInput writes data to the command through its shim, deduplicated by
// session and seq (spec 9.4). Data above MaxInputBytes is refused.
func (m *Manager) SendInput(ctx context.Context, req *agentv1.SendInputRequest) (bool, error) {
	if err := validateID(req.GetCommandId()); err != nil {
		return false, err
	}
	if !shimproto.ValidSession(req.GetInputSessionId()) {
		return false, errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument,
			"input_session_id must match [A-Za-z0-9._:-]{1,%d}", shimproto.MaxSessionLen)
	}
	if len(req.GetData()) > MaxInputBytes {
		return false, errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument,
			"data is %d bytes, at most %d per call", len(req.GetData()), MaxInputBytes)
	}
	client, err := m.liveClient(ctx, req.GetCommandId())
	if err != nil {
		return false, err
	}
	applied, err := client.Input(ctx, req.GetInputSessionId(), req.GetSeq(), req.GetData(), req.GetCloseStdin())
	if err != nil {
		return false, shimError(err)
	}
	return applied, nil
}

// Update resizes the PTY of a command.
func (m *Manager) Update(ctx context.Context, req *agentv1.UpdateRequest) error {
	if err := validateID(req.GetCommandId()); err != nil {
		return err
	}
	if req.GetCols() == 0 || req.GetRows() == 0 || req.GetCols() > math.MaxUint16 || req.GetRows() > math.MaxUint16 {
		return errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, "cols and rows must be 1..%d", math.MaxUint16)
	}
	client, err := m.liveClient(ctx, req.GetCommandId())
	if err != nil {
		return err
	}
	return shimError(client.Resize(ctx, uint16(req.GetCols()), uint16(req.GetRows()))) //nolint:gosec // checked above
}

// liveClient returns the shim connection of a command whose main process
// runs: command_exited after the exit, shim_outdated for a shim without a
// common protocol, shim_unavailable while no connection is up.
func (m *Manager) liveClient(ctx context.Context, id string) (*shimproto.Client, error) {
	rec, err := m.getRecord(id)
	if err != nil {
		return nil, err
	}
	if rec.State == StateExited {
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.CommandExited, "command %q has exited", id)
	}
	client, outdated := m.awaitClient(ctx, id)
	switch {
	case client != nil:
		return client, nil
	case outdated:
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.ShimOutdated, "the shim of %q speaks an unsupported protocol", id)
	default:
		return nil, errs.Newf(connect.CodeUnavailable, errs.ShimUnavailable, "the shim of %q is not connected", id)
	}
}

// awaitClient returns the shim connection of id and whether the shim is
// outdated. While the unit is alive but the monitor has not connected yet
// (right after Start or an agent restart) it waits up to dialTimeout.
func (m *Manager) awaitClient(ctx context.Context, id string) (*shimproto.Client, bool) {
	timer := time.NewTimer(dialTimeout)
	defer timer.Stop()
	for {
		m.mu.Lock()
		c := m.cmds[id]
		if c == nil {
			m.mu.Unlock()
			return nil, false
		}
		if c.client != nil || c.outdated || !c.unitAlive {
			client, outdated := c.client, c.outdated
			m.mu.Unlock()
			return client, outdated
		}
		wake := c.wake
		m.mu.Unlock()
		select {
		case <-wake:
		case <-timer.C:
			return nil, false
		case <-ctx.Done():
			return nil, false
		}
	}
}

// Signal sends a signal to the process group of the main process; SIGKILL
// kills the whole payload cgroup (spec 9.5). On an exited command without
// leftovers it does nothing.
func (m *Manager) Signal(ctx context.Context, req *agentv1.SignalRequest) (*agentv1.CommandInfo, error) {
	if err := validateID(req.GetCommandId()); err != nil {
		return nil, err
	}
	sig, err := parseSignal(req.GetSignal())
	if err != nil {
		return nil, err
	}
	id := req.GetCommandId()
	act, err := m.needsAction(id)
	if err != nil || !act {
		return m.infoOrErr(id, err)
	}
	client, outdated := m.awaitClient(ctx, id)
	switch {
	case client != nil:
		if err := client.Signal(ctx, sig, sig == sigKILL); err != nil && !isExitedErr(err) {
			return nil, shimError(err)
		}
	case sig == sigKILL:
		if err := m.killCgroup(ctx, id); err != nil {
			return nil, err
		}
	case outdated:
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.ShimOutdated, "the shim of %q speaks an unsupported protocol", id)
	default:
		return nil, errs.Newf(connect.CodeUnavailable, errs.ShimUnavailable, "the shim of %q is not connected", id)
	}
	return m.infoOrErr(id, nil)
}

// Kill stops a command: SIGTERM, then the cgroup kill after the grace
// (default DefaultKillGraceMs), run by the shim; without a shim the agent
// kills the cgroup itself. On an exited command without leftovers it does
// nothing.
func (m *Manager) Kill(ctx context.Context, req *agentv1.KillRequest) (*agentv1.CommandInfo, error) {
	if err := validateID(req.GetCommandId()); err != nil {
		return nil, err
	}
	id := req.GetCommandId()
	grace := uint32(DefaultKillGraceMs)
	if req.GraceMs != nil {
		grace = req.GetGraceMs()
	}
	act, err := m.needsAction(id)
	if err != nil || !act {
		return m.infoOrErr(id, err)
	}
	client, outdated := m.awaitClient(ctx, id)
	switch {
	case client != nil:
		if err := client.Kill(ctx, grace, 0, shimproto.ReasonSignal); err != nil && !isExitedErr(err) {
			return nil, shimError(err)
		}
	case outdated && grace > 0:
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.ShimOutdated,
			"the shim of %q speaks an unsupported protocol; kill with grace_ms 0", id)
	default:
		if err := m.killCgroup(ctx, id); err != nil {
			return nil, err
		}
	}
	return m.infoOrErr(id, nil)
}

// needsAction reports whether a signal or kill can reach anything: the
// main process runs or leftovers remain.
func (m *Manager) needsAction(id string) (bool, error) {
	rec, err := m.getRecord(id)
	if err != nil {
		return false, err
	}
	if rec.State != StateExited {
		return true, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.cmds[id]
	return c != nil && c.leftovers, nil
}

func (m *Manager) killCgroup(ctx context.Context, id string) error {
	err := m.sup.KillCgroup(ctx, id)
	if err == nil || errors.Is(err, supervisor.ErrUnitNotFound) {
		return nil
	}
	return errs.New(connect.CodeInternal, errs.Internal, err.Error())
}

func (m *Manager) infoOrErr(id string, err error) (*agentv1.CommandInfo, error) {
	if err != nil {
		return nil, err
	}
	rec, err := m.getRecord(id)
	if err != nil {
		return nil, err
	}
	return m.info(rec), nil
}

// Get returns the state of a command.
func (m *Manager) Get(id string) (*agentv1.CommandInfo, error) {
	if err := validateID(id); err != nil {
		return nil, err
	}
	return m.infoOrErr(id, nil)
}

// List returns one page of commands in id order, filtered by state and
// tags. The page token is the last id of the previous page.
func (m *Manager) List(req *agentv1.ProcessListRequest) (*agentv1.ProcessListResponse, error) {
	size := int(req.GetPageSize())
	switch {
	case size == 0:
		size = DefaultPageSize
	case size > MaxPageSize:
		size = MaxPageSize
	}
	var state string
	if req.GetState() != agentv1.CommandState_COMMAND_STATE_UNSPECIFIED {
		state = strings.TrimPrefix(req.GetState().String(), "COMMAND_STATE_")
	}
	var page []*store.Command
	more := false
	err := m.st.ListCommands(func(c *store.Command) bool {
		if c.ID <= req.GetPageToken() {
			return true
		}
		if state != "" && c.State != state {
			return true
		}
		for k, v := range req.GetTags() {
			if tv, ok := c.Tags[k]; !ok || tv != v {
				return true
			}
		}
		if len(page) == size {
			more = true
			return false
		}
		page = append(page, c)
		return true
	})
	if err != nil {
		return nil, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	res := &agentv1.ProcessListResponse{}
	for _, c := range page {
		res.Commands = append(res.Commands, m.info(c))
	}
	if more {
		res.NextPageToken = page[len(page)-1].ID
	}
	return res, nil
}

// Remove forgets an exited command: its record and its logs. A running
// command (or one with live leftovers) is refused with command_running.
func (m *Manager) Remove(ctx context.Context, id string) (bool, error) {
	if err := validateID(id); err != nil {
		return false, err
	}
	c := m.entry(id)
	c.recMu.Lock()
	defer c.recMu.Unlock()
	rec, ok, err := m.st.GetCommand(id)
	if err != nil {
		return false, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	if !ok {
		m.forget(c)
		return false, nil
	}
	if rec.State != StateExited {
		return false, errs.Newf(connect.CodeFailedPrecondition, errs.CommandRunning, "command %q is running", id)
	}
	alive, err := m.unitStillAlive(ctx, c)
	if err != nil {
		return false, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	if alive {
		return false, errs.Newf(connect.CodeFailedPrecondition, errs.CommandRunning, "leftovers of %q still run", id)
	}
	dctx, cancel := m.durableCtx(ctx)
	defer cancel()
	if err := m.st.DeleteCommand(dctx, id); err != nil {
		return false, storeError(err)
	}
	if err := os.RemoveAll(m.opts.Layout.CommandDir(id)); err != nil {
		m.log.Warn("process: remove command dir", "id", id, "err", err)
	}
	m.forget(c)
	return true, nil
}

// unitStillAlive checks the unit of an exited command: the live state may
// lag behind a unit that just went away.
func (m *Manager) unitStillAlive(ctx context.Context, c *command) (bool, error) {
	if !m.unitAliveOf(c) {
		return false, nil
	}
	alive, err := m.unitState(ctx, c.id)
	if err != nil {
		return false, err
	}
	if !alive {
		m.markGone(c)
	}
	return alive, nil
}

// isExitedErr reports a shim answer that the main process has exited.
func isExitedErr(err error) bool {
	var perr *shimproto.Error
	return errors.As(err, &perr) && perr.Code == shimproto.CodeCommandExited
}

// shimError maps a failed shim call.
func shimError(err error) error {
	if err == nil {
		return nil
	}
	var perr *shimproto.Error
	if errors.As(err, &perr) {
		switch perr.Code {
		case shimproto.CodeCommandExited:
			return errs.New(connect.CodeFailedPrecondition, errs.CommandExited, perr.Error())
		case shimproto.CodeShimOutdated:
			return errs.New(connect.CodeFailedPrecondition, errs.ShimOutdated, perr.Error())
		case shimproto.CodeFailedPrecondition:
			return errs.New(connect.CodeFailedPrecondition, errs.FailedPrecondition, perr.Error())
		case shimproto.CodeInvalidArgument:
			return errs.New(connect.CodeInvalidArgument, errs.InvalidArgument, perr.Error())
		default:
			return errs.New(connect.CodeInternal, errs.Internal, perr.Error())
		}
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	default:
		return errs.New(connect.CodeUnavailable, errs.ShimUnavailable, err.Error())
	}
}

// signalNumbers maps the Linux signal names (without "SIG") to numbers.
var signalNumbers = map[string]syscall.Signal{
	"HUP": 1, "INT": 2, "QUIT": 3, "ILL": 4, "TRAP": 5, "ABRT": 6, "IOT": 6, "BUS": 7, "FPE": 8,
	"KILL": 9, "USR1": 10, "SEGV": 11, "USR2": 12, "PIPE": 13, "ALRM": 14, "TERM": 15,
	"STKFLT": 16, "CHLD": 17, "CONT": 18, "STOP": 19, "TSTP": 20, "TTIN": 21, "TTOU": 22,
	"URG": 23, "XCPU": 24, "XFSZ": 25, "VTALRM": 26, "PROF": 27, "WINCH": 28, "IO": 29,
	"POLL": 29, "PWR": 30, "SYS": 31,
}

// parseSignal accepts "SIGINT", "INT" (any case) or a decimal number
// 1..shimproto.MaxSignal.
func parseSignal(s string) (syscall.Signal, error) {
	bad := errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument,
		"signal %q: want a name such as SIGTERM or a number 1..%d", s, shimproto.MaxSignal)
	if n, err := strconv.Atoi(s); err == nil {
		if shimproto.CheckSignal(n) != nil {
			return 0, bad
		}
		return syscall.Signal(n), nil
	}
	name := strings.TrimPrefix(strings.ToUpper(s), "SIG")
	if sig, ok := signalNumbers[name]; ok {
		return sig, nil
	}
	return 0, bad
}
