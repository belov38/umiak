package process

import (
	"os"
	"slices"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// info builds the CommandInfo of a record and the live state.
func (m *Manager) info(rec *store.Command) *agentv1.CommandInfo {
	spec := &agentv1.CommandSpec{}
	if len(rec.Spec) > 0 {
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(rec.Spec, spec); err != nil {
			m.log.Warn("process: decode stored spec", "id", rec.ID, "err", err)
		}
	}
	info := &agentv1.CommandInfo{
		CommandId:    rec.ID,
		Spec:         spec,
		EnvKeys:      slices.Clone(rec.EnvKeys),
		State:        agentv1.CommandState(agentv1.CommandState_value["COMMAND_STATE_"+rec.State]),
		Pid:          int32(rec.Pid), //nolint:gosec // a pid fits
		CreatedAt:    ts(rec.CreatedAt),
		StartedAt:    ts(rec.StartedAt),
		EndedAt:      ts(rec.EndedAt),
		AgentVersion: rec.AgentVersion,
	}
	if e := rec.Exit; e != nil {
		info.Exit = &agentv1.ExitInfo{Status: exitStatusEnum(e.Status), Code: e.Code, Signal: e.Signal,
			Reason: exitReasonEnum(e.Reason)}
	}
	exited := rec.State == StateExited
	for _, name := range streamNames(rec.PTY) {
		si := &agentv1.StreamInfo{Stream: streamEnum(name)}
		if f, err := os.Open(m.cmdPath(rec.ID, name)); err == nil {
			if fi, err := f.Stat(); err == nil {
				si.Size = nonNeg(fi.Size())
				if avail, err := m.opts.Output.AvailableFrom(f, fi.Size()); err == nil {
					si.AvailableFrom = nonNeg(avail)
				}
			}
			_ = f.Close()
		}
		if exited {
			end := rec.Ends[name]
			si.End = &end
		}
		info.Streams = append(info.Streams, si)
	}
	if c := m.lookup(rec.ID); c != nil {
		m.mu.Lock()
		info.HasLeftovers = c.leftovers
		info.AttachedClients = uint32(c.attaches) //nolint:gosec // non-negative count
		m.mu.Unlock()
	}
	return info
}

func ts(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}
