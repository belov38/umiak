package agent

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
)

// Status is /run/umiak-agent/status.json, written every StatusEvery for
// `umiak-agent doctor` (spec 17.6). It never holds the boot secret or the
// machine token.
type Status struct {
	Version   string          `json:"version"`
	PID       int             `json:"pid"`
	Tunnel    TunnelStatus    `json:"tunnel"`
	Identity  IdentityStatus  `json:"identity"`
	Readiness ReadinessStatus `json:"readiness"`
	// Quiesce and Update are the System/Info messages in protojson, null
	// without an active lease or a pending update.
	Quiesce    json.RawMessage `json:"quiesce"`
	Update     json.RawMessage `json:"update"`
	LogDropped uint64          `json:"log_dropped"`
	UpdatedAt  time.Time       `json:"updated_at"`
}

// TunnelStatus is the tunnel connection state.
type TunnelStatus struct {
	Connected bool   `json:"connected"`
	Gateway   string `json:"gateway"`
	ConnID    string `json:"conn_id"`
	Epoch     uint64 `json:"epoch"`
	LastError string `json:"last_error"`
	// Since is when the connection state last changed.
	Since time.Time `json:"since"`
	// URL and URLSource are the effective tunnel URL and where it came
	// from (smbios or config); empty until the tunnel starts.
	URL       string `json:"url"`
	URLSource string `json:"url_source"`
}

// IdentityStatus is the machine identity without the boot secret.
type IdentityStatus struct {
	MachineID string `json:"machine_id"`
	// State is ready or failed.
	State           string `json:"state"`
	Error           string `json:"error,omitempty"`
	TunnelURL       string `json:"tunnel_url"`
	TunnelURLSource string `json:"tunnel_url_source"`
}

// ReadinessStatus is the readiness of the agent (spec 8.5).
type ReadinessStatus struct {
	Ready  bool          `json:"ready"`
	Phases []PhaseStatus `json:"phases"`
}

// PhaseStatus is one readiness phase. ReadyAt is when it first became
// ready; ReadyAtMonotonicUs is the same moment on CLOCK_MONOTONIC in
// microseconds, comparable with systemd's *TimestampMonotonic (S5 13.1).
type PhaseStatus struct {
	Name               string     `json:"name"`
	State              string     `json:"state"`
	Error              string     `json:"error,omitempty"`
	ReadyAt            *time.Time `json:"ready_at,omitempty"`
	ReadyAtMonotonicUs int64      `json:"ready_at_monotonic_us,omitempty"`
}

// monoRef maps a time.Time of this process to CLOCK_MONOTONIC: one reading
// of both clocks at startup, and the monotonic difference since then.
type monoRef struct {
	at   time.Time
	mono time.Duration
	ok   bool
}

func newMonoRef() monoRef {
	m, ok := monotonicNow()
	return monoRef{at: time.Now(), mono: m, ok: ok}
}

// micros returns t on CLOCK_MONOTONIC in microseconds, or 0.
func (r monoRef) micros(t time.Time) int64 {
	if !r.ok || t.IsZero() {
		return 0
	}
	return (r.mono + t.Sub(r.at)).Microseconds()
}

// phaseStateName returns "ready" for PHASE_STATE_READY and so on.
func phaseStateName(s agentv1.PhaseState) string {
	return strings.ToLower(strings.TrimPrefix(s.String(), "PHASE_STATE_"))
}

// status builds the current status.
func (a *agent) status() Status {
	s := Status{
		Version:    a.version,
		PID:        os.Getpid(),
		Tunnel:     a.tunnel.snapshot(),
		LogDropped: a.d.LogDropped(),
		UpdatedAt:  a.d.Now().UTC(),
	}
	url, source := a.identity.tunnelURL()
	s.Identity = IdentityStatus{
		MachineID:       a.identity.machineID(),
		State:           "ready",
		TunnelURL:       url,
		TunnelURLSource: source,
	}
	if !a.identity.ready() {
		s.Identity.State, s.Identity.Error = "failed", a.identity.errText()
	}
	if a.tracker != nil {
		phases, ready := a.tracker.Snapshot()
		s.Readiness.Ready = ready
		for _, p := range phases {
			ps := PhaseStatus{Name: p.GetName(), State: phaseStateName(p.GetState()), Error: p.GetError()}
			if at := a.tracker.ReadyAt(p.GetName()); !at.IsZero() {
				utc := at.UTC()
				ps.ReadyAt = &utc
				ps.ReadyAtMonotonicUs = a.monoRef.micros(at)
			}
			s.Readiness.Phases = append(s.Readiness.Phases, ps)
		}
	}
	if a.quiesce != nil {
		s.Quiesce = protoJSON(a.quiesce.Status())
	}
	if a.updater != nil {
		s.Update = protoJSON(a.updater.Status())
	}
	return s
}

// protoJSON encodes m with proto field names; nil gives JSON null.
func protoJSON[M proto.Message](m M) json.RawMessage {
	if !m.ProtoReflect().IsValid() {
		return nil
	}
	b, err := protojson.MarshalOptions{UseProtoNames: true}.Marshal(m)
	if err != nil {
		return nil
	}
	return b
}

// writeStatus writes status.json atomically.
func (a *agent) writeStatus() {
	b, err := json.MarshalIndent(a.status(), "", "  ")
	if err != nil {
		a.log.Warn("agent: encode status", "err", err)
		return
	}
	if err := fsutil.WriteFileAtomic(a.l.StatusFile, append(b, '\n'), 0o644); err != nil {
		a.log.Warn("agent: write status.json", "err", err)
	}
}

// statusLoop writes status.json every StatusEvery until ctx ends.
func (a *agent) statusLoop(ctx context.Context) {
	t := time.NewTicker(a.d.StatusEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.writeStatus()
		}
	}
}
