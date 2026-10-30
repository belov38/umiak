package system

import (
	"log/slog"
	"slices"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// InfoSource gives the parts of System/Info that do not change while the
// agent runs.
type InfoSource interface {
	Static() StaticInfo
}

// StaticInfo is the static identity of the agent and the machine.
type StaticInfo struct {
	Version         string
	PreviousVersion string
	OS              string
	Arch            string
	Kernel          string
	BootID          string
	MachineID       string
	DefaultUser     string
	TunnelURL       string
	TunnelURLSource string
	BootTime        time.Time
	SSHHostKeys     []string
}

// info builds the Info response: the static fields merged with the
// hostname, the claim (without secret values), readiness, quiesce, update
// and idle state.
func (s *Service) info() *agentv1.InfoResponse {
	st := s.opts.Info.Static()
	res := &agentv1.InfoResponse{
		Version:         st.Version,
		PreviousVersion: st.PreviousVersion,
		Os:              st.OS,
		Arch:            st.Arch,
		Kernel:          st.Kernel,
		BootId:          st.BootID,
		MachineId:       st.MachineID,
		SshHostKeys:     slices.Clone(st.SSHHostKeys),
		DefaultUser:     st.DefaultUser,
		TunnelUrl:       st.TunnelURL,
		TunnelUrlSource: st.TunnelURLSource,
	}
	if !st.BootTime.IsZero() {
		res.BootTime = timestamppb.New(st.BootTime)
	}
	if h, err := s.opts.Hostname(); err == nil {
		res.Hostname = h
	} else {
		slog.Warn("read hostname failed", "err", err)
	}
	if c := s.opts.Claim; c != nil {
		res.SandboxId = c.SandboxID()
		res.Claim = c.ClaimInfo()
	}
	res.Readiness, res.Ready = s.opts.Ready.Snapshot()
	if q := s.opts.Quiesce; q != nil {
		res.Quiesce = q.Status()
	}
	if u := s.opts.Update; u != nil {
		res.Update = u.Status()
	}
	if i := s.opts.Idle; i != nil {
		if since, ok := i.IdleSince(); ok {
			res.IdleSince = timestamppb.New(since)
		}
	}
	return res
}
