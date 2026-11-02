package process

import (
	"context"
	"errors"
	"net/http"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/umiak/libs/tunnel/rpcconv"
	testingv1 "github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1"
	"github.com/belov38/umiak/libs/tunnel/tunneltest/testpb/umiak/testing/v1/testingv1connect"
)

// Handler returns the path and handler of the Process service backed by s.
// Mutating unary calls need Umiak-Request-Id (rpcconv.RequireRequestID);
// Start is exempt, its key is command_id.
func (s *Store) Handler(opts ...connect.HandlerOption) (string, http.Handler) {
	all := append([]connect.HandlerOption{
		connect.WithInterceptors(rpcconv.RequireRequestID(testingv1connect.ProcessStartProcedure)),
	}, opts...)
	return testingv1connect.NewProcessHandler(service{s}, all...)
}

// service implements testingv1connect.ProcessHandler.
type service struct{ s *Store }

var _ testingv1connect.ProcessHandler = service{}

func validate(id string, spec *testingv1.CommandSpec) error {
	switch {
	case id == "":
		return connect.NewError(connect.CodeInvalidArgument, errors.New("command_id is required"))
	case spec == nil:
		return connect.NewError(connect.CodeInvalidArgument, errors.New("spec is required"))
	case spec.GetLineBytes() != 0 && spec.GetLineBytes() < minLineBytes:
		return connect.NewError(connect.CodeInvalidArgument, errors.New("line_bytes must be 0 or at least 32"))
	case spec.GetInterval().AsDuration() < 0:
		return connect.NewError(connect.CodeInvalidArgument, errors.New("interval must not be negative"))
	}
	return nil
}

// startCommand validates and starts (or finds) a command.
func (v service) startCommand(id string, spec *testingv1.CommandSpec) (*command, bool, error) {
	if err := validate(id, spec); err != nil {
		return nil, false, err
	}
	c, created, err := v.s.start(id, spec)
	if errors.Is(err, errAlreadyExists) {
		return nil, false, connect.NewError(connect.CodeAlreadyExists, err)
	}
	return c, created, err
}

func (v service) Start(_ context.Context, req *connect.Request[testingv1.StartRequest]) (*connect.Response[testingv1.StartResponse], error) {
	id := req.Msg.GetCommandId()
	v.s.invoked(id)
	_, created, err := v.startCommand(id, req.Msg.GetSpec())
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&testingv1.StartResponse{CommandId: id, Created: created}), nil
}

func (v service) lookup(id string) (*command, error) {
	c := v.s.get(id)
	if c == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("unknown command "+id))
	}
	return c, nil
}

func (v service) Attach(ctx context.Context, req *connect.Request[testingv1.AttachRequest], stream *connect.ServerStream[testingv1.AttachResponse]) error {
	c, err := v.lookup(req.Msg.GetCommandId())
	if err != nil {
		return err
	}
	return v.s.attach(ctx, c, [2]uint64{req.Msg.GetStdoutOffset(), req.Msg.GetStderrOffset()}, stream)
}

func (v service) Run(ctx context.Context, req *connect.Request[testingv1.RunRequest], stream *connect.ServerStream[testingv1.AttachResponse]) error {
	id := req.Msg.GetCommandId()
	v.s.invoked(id)
	c, _, err := v.startCommand(id, req.Msg.GetSpec())
	if err != nil {
		return err
	}
	if err := stream.Send(&testingv1.AttachResponse{Event: &testingv1.AttachResponse_Started{
		Started: &testingv1.StartedEvent{CommandId: id},
	}}); err != nil {
		return err
	}
	return v.s.attach(ctx, c, [2]uint64{}, stream)
}

func (v service) SetLabel(_ context.Context, req *connect.Request[testingv1.SetLabelRequest]) (*connect.Response[testingv1.SetLabelResponse], error) {
	c, err := v.lookup(req.Msg.GetCommandId())
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.labels++
	n := c.labels
	c.mu.Unlock()
	return connect.NewResponse(&testingv1.SetLabelResponse{Calls: n}), nil
}

func (v service) Signal(_ context.Context, req *connect.Request[testingv1.SignalRequest]) (*connect.Response[testingv1.SignalResponse], error) {
	c, err := v.lookup(req.Msg.GetCommandId())
	if err != nil {
		return nil, err
	}
	sig := req.Msg.GetSignal()
	if sig == "" {
		sig = "SIGKILL"
	}
	c.signalKill(sig)
	return connect.NewResponse(&testingv1.SignalResponse{}), nil
}

// Echo returns the payload; attack is ignored (see the tunnel harness).
func (service) Echo(_ context.Context, req *connect.Request[testingv1.EchoRequest]) (*connect.Response[testingv1.EchoResponse], error) {
	return connect.NewResponse(&testingv1.EchoResponse{Payload: req.Msg.GetPayload()}), nil
}

// EchoStream sends count messages with their index and the payload.
func (service) EchoStream(_ context.Context, req *connect.Request[testingv1.EchoStreamRequest], stream *connect.ServerStream[testingv1.EchoStreamResponse]) error {
	for i := range req.Msg.GetCount() {
		if err := stream.Send(&testingv1.EchoStreamResponse{Index: i, Payload: req.Msg.GetPayload()}); err != nil {
			return err
		}
	}
	return nil
}

// attach streams c from off (spec 9.1): data chunks of at most 64 KiB from
// each stream in turn, waiting for new output (an offset beyond the end
// waits too), truncated for output dropped by retention, a heartbeat after
// HeartbeatAfter without a message, and exit once both streams were sent
// to their ends. Send blocks under HTTP/2 flow control, so a slow client
// slows the sender and nothing piles up here.
func (s *Store) attach(ctx context.Context, c *command, off [2]uint64, stream *connect.ServerStream[testingv1.AttachResponse]) error {
	hb := time.NewTimer(s.opts.HeartbeatAfter)
	defer hb.Stop()
	turn := 0
	for {
		ev, wait := c.next(&off, &turn)
		if ev == nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-wait:
				continue
			case <-hb.C:
				ev = &testingv1.AttachResponse{Event: &testingv1.AttachResponse_Heartbeat{Heartbeat: &testingv1.HeartbeatEvent{}}}
			}
		}
		if err := stream.Send(ev); err != nil {
			return err
		}
		if d := ev.GetData(); d != nil {
			c.sent.Add(uint64(len(d.GetData())))
		}
		if ev.GetExit() != nil {
			return nil
		}
		hb.Reset(s.opts.HeartbeatAfter)
	}
}
