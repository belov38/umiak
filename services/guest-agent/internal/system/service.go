// Package system implements the sbx.agent.v1.System service (spec section
// 13): machine information, metrics, ports, activity counters, the claim
// lifecycle, quiesce and update delegation, plus the activity and idle loops
// that feed the event journal.
package system

import (
	"context"
	"errors"
	"net/http"
	"os"
	"slices"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
)

// maxMessageBytes bounds Connect messages in both directions.
const maxMessageBytes = 16 << 20

// Quiesce lease bounds (spec section 14.2).
const (
	DefaultLeaseMs = 30000
	MaxLeaseMs     = 120000
)

// Readiness reports the readiness phases; *readiness.Tracker implements it.
type Readiness interface {
	Snapshot() ([]*agentv1.Phase, bool)
}

// Claimer applies the claim lifecycle; *claim.Manager implements it. Its
// methods return *connect.Error values that are passed through as is.
type Claimer interface {
	Claim(ctx context.Context, req *agentv1.ClaimRequest) (*agentv1.ClaimResponse, error)
	UpdateEnv(ctx context.Context, req *agentv1.UpdateEnvRequest) (*agentv1.UpdateEnvResponse, error)
	UpdateSecrets(ctx context.Context, req *agentv1.UpdateSecretsRequest) (*agentv1.UpdateSecretsResponse, error)
	UpdateSshCa(ctx context.Context, req *agentv1.UpdateSshCaRequest) (*agentv1.UpdateSshCaResponse, error) //nolint:revive // named after the System.UpdateSshCa RPC
	PrepareStop(ctx context.Context) error
	// ClaimInfo returns the claim without secret values, or nil.
	ClaimInfo() *agentv1.ClaimInfo
	// SandboxID returns the claimed sandbox id, or "".
	SandboxID() string
}

// PortLister lists the listening ports; *ports.Scanner implements it.
type PortLister interface {
	List() []*agentv1.Port
}

// Counts reports live work; *process.Manager implements it. running counts
// commands whose unit is alive, ptys live PTY commands, attaches the open
// attach streams.
type Counts interface {
	Counts() (running, ptys, attaches int)
}

// Quiescer freezes the machine for snapshots (spec section 14).
type Quiescer interface {
	// Quiesce starts a lease of leaseMs; docker and fs select what to
	// freeze. The defaults are already applied.
	Quiesce(ctx context.Context, leaseMs uint32, docker, fs bool) (*agentv1.QuiesceResponse, error)
	// Thaw ends a lease and reports whether it was thawed automatically.
	Thaw(ctx context.Context, leaseID string) (*agentv1.ThawResponse, error)
	// Status returns the current lease, or nil.
	Status() *agentv1.QuiesceStatus
}

// Updater installs agent updates (spec section 17.4). Apply answers before
// the agent restarts; restarting is the Updater's job.
type Updater interface {
	Apply(ctx context.Context, uploadID string, allowBad bool) (*agentv1.ApplyUpdateResponse, error)
	// Status returns the pending update state, or nil.
	Status() *agentv1.UpdateStatus
}

// MetricsSource collects resource usage; GopsutilMetrics implements it. The
// service fills in the command, attach and TCP stream counts.
type MetricsSource interface {
	Collect(ctx context.Context) (*agentv1.MetricsResponse, error)
}

// IdleSource reports since when the machine is idle; *IdleLoop implements
// it.
type IdleSource interface {
	IdleSince() (time.Time, bool)
}

// Options configures a Service. Info and Ready are required. Optional
// sources must be left as untyped nil when absent: Quiesce, Update, Metrics
// and Claim then answer unimplemented, the others report empty values.
type Options struct {
	// Info gives the static identity of the agent and the machine.
	Info InfoSource
	// Ready reports the readiness phases.
	Ready Readiness
	// Claim applies Claim, UpdateEnv, UpdateSecrets, UpdateSshCa and
	// PrepareStop and reports the claim in Info.
	Claim Claimer
	// Ports lists the listening ports.
	Ports PortLister
	// TCP counts the live CONNECT streams.
	TCP *ports.Counter
	// Proc counts commands, PTYs and attach streams.
	Proc Counts
	// Quiesce handles Quiesce and Thaw.
	Quiesce Quiescer
	// Update handles ApplyUpdate.
	Update Updater
	// Metrics collects resource usage.
	Metrics MetricsSource
	// Idle reports idle_since for Info.
	Idle IdleSource
	// Hostname returns the current hostname. Default os.Hostname.
	Hostname func() (string, error)
	// HandlerOptions are added to the Connect handler; the wiring passes
	// the shared reqcache.Interceptors here.
	HandlerOptions []connect.HandlerOption
}

// Service implements agentv1connect.SystemHandler.
type Service struct {
	opts Options
}

var _ agentv1connect.SystemHandler = (*Service)(nil)

// New returns a Service for opts.
func New(opts Options) (*Service, error) {
	switch {
	case opts.Info == nil:
		return nil, errors.New("system: Options.Info is required")
	case opts.Ready == nil:
		return nil, errors.New("system: Options.Ready is required")
	}
	if opts.Hostname == nil {
		opts.Hostname = os.Hostname
	}
	return &Service{opts: opts}, nil
}

// ConnectHandler returns the path and the handler of the sbx.agent.v1.System
// service: Options.HandlerOptions plus 16 MiB message limits and no gzip, so
// responses are never compressed.
func (s *Service) ConnectHandler() (string, http.Handler) {
	opts := slices.Concat(s.opts.HandlerOptions, []connect.HandlerOption{
		connect.WithReadMaxBytes(maxMessageBytes),
		connect.WithSendMaxBytes(maxMessageBytes),
		connect.WithCompression("gzip", nil, nil),
	})
	return agentv1connect.NewSystemHandler(s, opts...)
}

// Info implements agentv1connect.SystemHandler.
func (s *Service) Info(context.Context, *connect.Request[agentv1.InfoRequest]) (*connect.Response[agentv1.InfoResponse], error) {
	return connect.NewResponse(s.info()), nil
}

// Metrics implements agentv1connect.SystemHandler.
func (s *Service) Metrics(ctx context.Context, _ *connect.Request[agentv1.MetricsRequest]) (*connect.Response[agentv1.MetricsResponse], error) {
	if s.opts.Metrics == nil {
		return nil, unimplemented("metrics")
	}
	res, err := s.opts.Metrics.Collect(ctx)
	if err != nil {
		return nil, toConnect("collect metrics", err)
	}
	a := s.activity()
	res.RunningCommands = a.GetRunningCommands()
	res.AttachStreams = a.GetAttachStreams()
	res.TcpStreams = a.GetTcpStreams()
	return connect.NewResponse(res), nil
}

// ListPorts implements agentv1connect.SystemHandler.
func (s *Service) ListPorts(context.Context, *connect.Request[agentv1.ListPortsRequest]) (*connect.Response[agentv1.ListPortsResponse], error) {
	res := &agentv1.ListPortsResponse{}
	if s.opts.Ports != nil {
		res.Ports = s.opts.Ports.List()
	}
	return connect.NewResponse(res), nil
}

// Activity implements agentv1connect.SystemHandler.
func (s *Service) Activity(context.Context, *connect.Request[agentv1.ActivityRequest]) (*connect.Response[agentv1.ActivityResponse], error) {
	return connect.NewResponse(s.activity()), nil
}

// activity reads the live counters.
func (s *Service) activity() *agentv1.ActivityResponse {
	var running, ptys, attaches int
	if s.opts.Proc != nil {
		running, ptys, attaches = s.opts.Proc.Counts()
	}
	return &agentv1.ActivityResponse{
		RunningCommands: clampU32(int64(running)),
		OpenPtys:        clampU32(int64(ptys)),
		TcpStreams:      clampU32(loadTCP(s.opts.TCP)),
		AttachStreams:   clampU32(int64(attaches)),
	}
}

// Claim implements agentv1connect.SystemHandler.
func (s *Service) Claim(ctx context.Context, req *connect.Request[agentv1.ClaimRequest]) (*connect.Response[agentv1.ClaimResponse], error) {
	if s.opts.Claim == nil {
		return nil, unimplemented("claim")
	}
	res, err := s.opts.Claim.Claim(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

// UpdateEnv implements agentv1connect.SystemHandler.
func (s *Service) UpdateEnv(ctx context.Context, req *connect.Request[agentv1.UpdateEnvRequest]) (*connect.Response[agentv1.UpdateEnvResponse], error) {
	if s.opts.Claim == nil {
		return nil, unimplemented("claim")
	}
	res, err := s.opts.Claim.UpdateEnv(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

// UpdateSecrets implements agentv1connect.SystemHandler.
func (s *Service) UpdateSecrets(ctx context.Context, req *connect.Request[agentv1.UpdateSecretsRequest]) (*connect.Response[agentv1.UpdateSecretsResponse], error) {
	if s.opts.Claim == nil {
		return nil, unimplemented("claim")
	}
	res, err := s.opts.Claim.UpdateSecrets(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

// UpdateSshCa implements agentv1connect.SystemHandler.
func (s *Service) UpdateSshCa(ctx context.Context, req *connect.Request[agentv1.UpdateSshCaRequest]) (*connect.Response[agentv1.UpdateSshCaResponse], error) { //nolint:revive // named after the System.UpdateSshCa RPC
	if s.opts.Claim == nil {
		return nil, unimplemented("claim")
	}
	res, err := s.opts.Claim.UpdateSshCa(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

// PrepareStop implements agentv1connect.SystemHandler.
func (s *Service) PrepareStop(ctx context.Context, _ *connect.Request[agentv1.PrepareStopRequest]) (*connect.Response[agentv1.PrepareStopResponse], error) {
	if s.opts.Claim == nil {
		return nil, unimplemented("claim")
	}
	if err := s.opts.Claim.PrepareStop(ctx); err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.PrepareStopResponse{}), nil
}

// Quiesce implements agentv1connect.SystemHandler. Unset fields take the
// spec defaults: lease_ms 30000, docker and fs true.
func (s *Service) Quiesce(ctx context.Context, req *connect.Request[agentv1.QuiesceRequest]) (*connect.Response[agentv1.QuiesceResponse], error) {
	if s.opts.Quiesce == nil {
		return nil, unimplemented("quiesce")
	}
	m := req.Msg
	leaseMs := uint32(DefaultLeaseMs)
	if m.LeaseMs != nil {
		leaseMs = m.GetLeaseMs()
	}
	if leaseMs == 0 || leaseMs > MaxLeaseMs {
		return nil, errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument,
			"lease_ms must be in 1..%d", MaxLeaseMs)
	}
	docker := m.Docker == nil || m.GetDocker()
	fs := m.Fs == nil || m.GetFs()
	res, err := s.opts.Quiesce.Quiesce(ctx, leaseMs, docker, fs)
	if err != nil {
		return nil, toConnect("quiesce", err)
	}
	return connect.NewResponse(res), nil
}

// Thaw implements agentv1connect.SystemHandler.
func (s *Service) Thaw(ctx context.Context, req *connect.Request[agentv1.ThawRequest]) (*connect.Response[agentv1.ThawResponse], error) {
	if s.opts.Quiesce == nil {
		return nil, unimplemented("quiesce")
	}
	res, err := s.opts.Quiesce.Thaw(ctx, req.Msg.GetLeaseId())
	if err != nil {
		return nil, toConnect("thaw", err)
	}
	return connect.NewResponse(res), nil
}

// ApplyUpdate implements agentv1connect.SystemHandler.
func (s *Service) ApplyUpdate(ctx context.Context, req *connect.Request[agentv1.ApplyUpdateRequest]) (*connect.Response[agentv1.ApplyUpdateResponse], error) {
	if s.opts.Update == nil {
		return nil, unimplemented("update")
	}
	res, err := s.opts.Update.Apply(ctx, req.Msg.GetUploadId(), req.Msg.GetAllowBadVersion())
	if err != nil {
		return nil, toConnect("apply update", err)
	}
	return connect.NewResponse(res), nil
}

// unimplemented reports a feature this agent build does not wire.
func unimplemented(what string) *connect.Error {
	return errs.New(connect.CodeUnimplemented, errs.Unimplemented, what+" is not available")
}

// toConnect passes a *connect.Error through and maps anything else to
// internal.
func toConnect(what string, err error) error {
	var cerr *connect.Error
	if errors.As(err, &cerr) {
		return cerr
	}
	return errs.New(connect.CodeInternal, errs.Internal, what+": "+err.Error())
}

// loadTCP returns the live stream count of c; nil counts as zero.
func loadTCP(c *ports.Counter) int64 {
	if c == nil {
		return 0
	}
	return c.Load()
}

// clampU32 converts a counter to the proto type, clamping to 0..MaxUint32.
func clampU32(n int64) uint32 {
	switch {
	case n <= 0:
		return 0
	case n > int64(^uint32(0)):
		return ^uint32(0)
	default:
		return uint32(n)
	}
}
