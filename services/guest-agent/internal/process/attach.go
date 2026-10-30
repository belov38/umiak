package process

import (
	"context"
	"errors"
	"os"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/output"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// sendFunc delivers one attach event; it blocks under flow control.
type sendFunc func(*agentv1.AttachResponse) error

// attachParams selects where an attach starts.
type attachParams struct {
	offsets map[string]uint64 // by stream file name
	tail    uint64
	follow  bool
}

// Attach streams the output of a command from the requested offsets and
// ends with the exit event once every stream reached its end (spec 10).
func (m *Manager) Attach(ctx context.Context, req *agentv1.AttachRequest, send sendFunc) error {
	if err := validateID(req.GetCommandId()); err != nil {
		return err
	}
	p := attachParams{
		offsets: map[string]uint64{
			shim.StdoutFile: req.GetStdoutOffset(),
			shim.StderrFile: req.GetStderrOffset(),
			shim.PtyFile:    req.GetPtyOffset(),
		},
		tail:   req.GetTailBytes(),
		follow: req.Follow == nil || req.GetFollow(),
	}
	return m.attach(ctx, req.GetCommandId(), p, send)
}

// Run starts a command, sends started and attaches from offset 0.
func (m *Manager) Run(ctx context.Context, req *agentv1.RunRequest, send sendFunc) error {
	info, _, err := m.Start(ctx, req.GetCommandId(), req.GetSpec())
	if err != nil {
		return err
	}
	if err := send(&agentv1.AttachResponse{Event: &agentv1.AttachResponse_Started{
		Started: &agentv1.StartedEvent{CommandId: req.GetCommandId(), Command: info}}}); err != nil {
		return err
	}
	return m.attach(ctx, req.GetCommandId(), attachParams{offsets: map[string]uint64{}, follow: true}, send)
}

// attachStream is the read position of one stream of an attach.
type attachStream struct {
	name    string
	f       *os.File
	pos     int64
	tailSet bool // tail_bytes still has to be applied
}

func (m *Manager) attach(ctx context.Context, id string, p attachParams, send sendFunc) error {
	rec, err := m.getRecord(id)
	if err != nil {
		return err
	}
	c := m.entry(id)
	m.setPTY(c, rec.PTY)
	m.addAttach(c)
	defer m.dropAttach(c) //nolint:contextcheck // the idle timer outlives the stream

	dir := m.opts.Layout.CommandDir(id)
	watched := false
	defer func() {
		if watched {
			m.watch.remove(dir)
		}
	}()

	var streams []*attachStream
	for _, name := range streamNames(rec.PTY) {
		streams = append(streams, &attachStream{name: name, pos: clampOffset(p.offsets[name]), tailSet: p.tail > 0})
	}
	defer func() {
		for _, s := range streams {
			if s.f != nil {
				_ = s.f.Close()
			}
		}
	}()

	heartbeat := time.NewTimer(m.opts.Heartbeat)
	defer heartbeat.Stop()
	poll := time.NewTicker(m.opts.Poll)
	defer poll.Stop()

	for {
		if !watched {
			watched = m.watch.add(dir)
		}
		m.mu.Lock()
		wake := c.wake
		m.mu.Unlock()

		rec, ok, err := m.st.GetCommand(id)
		if err != nil {
			return errs.New(connect.CodeInternal, errs.Internal, err.Error())
		}
		if !ok {
			return notFound(id)
		}
		exited := rec.State == StateExited
		progressed, done := false, exited
		for _, s := range streams {
			sent, err := m.readStream(s, rec, exited, p.tail, send)
			if err != nil {
				return err
			}
			progressed = progressed || sent
			if exited && s.pos < endOf(rec, s.name) {
				done = false
			}
		}
		if done {
			return send(&agentv1.AttachResponse{Event: &agentv1.AttachResponse_Exit{Exit: exitEvent(rec)}})
		}
		if progressed {
			heartbeat.Reset(m.opts.Heartbeat)
			continue
		}
		if !p.follow {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-m.ctx.Done():
			return errs.New(connect.CodeUnavailable, errs.ShimUnavailable, "agent is shutting down")
		case <-wake:
		case <-poll.C:
		case <-heartbeat.C:
			if err := send(&agentv1.AttachResponse{Event: &agentv1.AttachResponse_Heartbeat{Heartbeat: &agentv1.HeartbeatEvent{}}}); err != nil {
				return err
			}
			heartbeat.Reset(m.opts.Heartbeat)
		}
	}
}

// readStream sends at most one event of stream s (a truncation or a data
// chunk) and reports whether it sent one.
func (m *Manager) readStream(s *attachStream, rec *store.Command, exited bool, tail uint64, send sendFunc) (bool, error) {
	if s.f == nil {
		f, err := os.Open(m.cmdPath(rec.ID, s.name))
		if errors.Is(err, os.ErrNotExist) {
			return false, nil // not created yet
		}
		if err != nil {
			return false, errs.New(connect.CodeInternal, errs.Internal, err.Error())
		}
		s.f = f
	}
	limit := int64(-1)
	if exited {
		limit = endOf(rec, s.name)
		if s.pos >= limit {
			return false, nil
		}
	}
	if s.tailSet {
		s.tailSet = false
		if err := m.applyTail(s, limit, tail); err != nil {
			return false, err
		}
	}
	ch, err := output.ReadChunk(m.opts.Output, s.f, s.pos, limit, output.DefaultMaxChunk)
	if err != nil {
		return false, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	if !exited && len(ch.Data) > 0 {
		// The record lags behind exit.json until the monitor saves the
		// exit; leftovers may write past the end meanwhile. exit.json is
		// read after the chunk, so a chunk read before the exit is still
		// cut at the recorded end.
		if e, ok := m.readExit(rec.ID); ok {
			end := clampOffset(exitFromFile(e, rec.PTY).ends[s.name])
			ch.Data = ch.Data[:max(0, min(int64(len(ch.Data)), end-s.pos))]
		}
	}
	stream := streamEnum(s.name)
	switch {
	case ch.Truncated:
		s.pos = ch.Offset
		return true, send(&agentv1.AttachResponse{Event: &agentv1.AttachResponse_Truncated{Truncated: &agentv1.TruncatedEvent{
			Stream: stream, AvailableFrom: nonNeg(ch.AvailableFrom)}}})
	case len(ch.Data) > 0:
		off := s.pos
		s.pos += int64(len(ch.Data))
		return true, send(&agentv1.AttachResponse{Event: &agentv1.AttachResponse_Data{Data: &agentv1.DataEvent{
			Stream: stream, Offset: nonNeg(off), Data: ch.Data}}})
	default:
		return false, nil
	}
}

// applyTail moves s to max(available_from, size - tail); size is capped
// by the stream end of an exited command (limit >= 0).
func (m *Manager) applyTail(s *attachStream, limit int64, tail uint64) error {
	fi, err := s.f.Stat()
	if err != nil {
		return errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	size := fi.Size()
	if limit >= 0 {
		size = min(size, limit)
	}
	avail, err := m.opts.Output.AvailableFrom(s.f, fi.Size())
	if err != nil {
		return errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	start := size - clampOffset(tail)
	s.pos = max(start, avail, 0)
	return nil
}

// endOf returns the recorded end of a stream of an exited command.
func endOf(rec *store.Command, name string) int64 {
	return clampOffset(rec.Ends[name])
}

// clampOffset converts a wire offset to a file offset.
func clampOffset(v uint64) int64 {
	const maxOff = 1<<63 - 1
	if v > maxOff {
		return maxOff
	}
	return int64(v)
}
