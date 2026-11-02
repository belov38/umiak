package process

import (
	"context"
	"net/http"
	"slices"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/proto/umiak/agent/v1/agentv1connect"
)

// maxMessageBytes bounds Connect messages in both directions.
const maxMessageBytes = 16 << 20

// Handler returns the path and the handler of the umiak.agent.v1.Process
// service: Options.HandlerOptions plus 16 MiB message limits and no gzip,
// so responses are never compressed.
func (m *Manager) Handler() (string, http.Handler) {
	opts := slices.Concat(m.opts.HandlerOptions, []connect.HandlerOption{
		connect.WithReadMaxBytes(maxMessageBytes),
		connect.WithSendMaxBytes(maxMessageBytes),
		connect.WithCompression("gzip", nil, nil),
	})
	return agentv1connect.NewProcessHandler(service{m: m}, opts...)
}

// service adapts the Manager to agentv1connect.ProcessHandler.
type service struct{ m *Manager }

var _ agentv1connect.ProcessHandler = service{}

// Start implements agentv1connect.ProcessHandler.
func (s service) Start(ctx context.Context, req *connect.Request[agentv1.StartRequest]) (*connect.Response[agentv1.StartResponse], error) {
	info, created, err := s.m.Start(ctx, req.Msg.GetCommandId(), req.Msg.GetSpec())
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.StartResponse{Command: info, Created: created}), nil
}

// Run implements agentv1connect.ProcessHandler.
func (s service) Run(ctx context.Context, req *connect.Request[agentv1.RunRequest], stream *connect.ServerStream[agentv1.AttachResponse]) error {
	return s.m.Run(ctx, req.Msg, stream.Send)
}

// Attach implements agentv1connect.ProcessHandler.
func (s service) Attach(ctx context.Context, req *connect.Request[agentv1.AttachRequest], stream *connect.ServerStream[agentv1.AttachResponse]) error {
	return s.m.Attach(ctx, req.Msg, stream.Send)
}

// SendInput implements agentv1connect.ProcessHandler.
func (s service) SendInput(ctx context.Context, req *connect.Request[agentv1.SendInputRequest]) (*connect.Response[agentv1.SendInputResponse], error) {
	applied, err := s.m.SendInput(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.SendInputResponse{Applied: applied}), nil
}

// Update implements agentv1connect.ProcessHandler.
func (s service) Update(ctx context.Context, req *connect.Request[agentv1.UpdateRequest]) (*connect.Response[agentv1.UpdateResponse], error) {
	if err := s.m.Update(ctx, req.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.UpdateResponse{}), nil
}

// Signal implements agentv1connect.ProcessHandler.
func (s service) Signal(ctx context.Context, req *connect.Request[agentv1.SignalRequest]) (*connect.Response[agentv1.SignalResponse], error) {
	info, err := s.m.Signal(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.SignalResponse{Command: info}), nil
}

// Kill implements agentv1connect.ProcessHandler.
func (s service) Kill(ctx context.Context, req *connect.Request[agentv1.KillRequest]) (*connect.Response[agentv1.KillResponse], error) {
	info, err := s.m.Kill(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.KillResponse{Command: info}), nil
}

// Get implements agentv1connect.ProcessHandler.
func (s service) Get(_ context.Context, req *connect.Request[agentv1.GetRequest]) (*connect.Response[agentv1.GetResponse], error) {
	info, err := s.m.Get(req.Msg.GetCommandId())
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.GetResponse{Command: info}), nil
}

// List implements agentv1connect.ProcessHandler.
func (s service) List(_ context.Context, req *connect.Request[agentv1.ProcessListRequest]) (*connect.Response[agentv1.ProcessListResponse], error) {
	res, err := s.m.List(req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

// Remove implements agentv1connect.ProcessHandler.
func (s service) Remove(ctx context.Context, req *connect.Request[agentv1.ProcessRemoveRequest]) (*connect.Response[agentv1.ProcessRemoveResponse], error) {
	removed, err := s.m.Remove(ctx, req.Msg.GetCommandId())
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.ProcessRemoveResponse{Removed: removed}), nil
}
