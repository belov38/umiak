package rpcconv_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1/testingv1connect"
)

// stubProcess answers the calls the tests make; the others are unimplemented.
type stubProcess struct {
	testingv1connect.UnimplementedProcessHandler
}

func (stubProcess) Start(context.Context, *connect.Request[testingv1.StartRequest]) (*connect.Response[testingv1.StartResponse], error) {
	return connect.NewResponse(&testingv1.StartResponse{Created: true}), nil
}

func (stubProcess) Attach(_ context.Context, _ *connect.Request[testingv1.AttachRequest], s *connect.ServerStream[testingv1.AttachResponse]) error {
	return s.Send(&testingv1.AttachResponse{})
}

func (stubProcess) Run(context.Context, *connect.Request[testingv1.RunRequest], *connect.ServerStream[testingv1.AttachResponse]) error {
	return nil
}

func (stubProcess) SetLabel(context.Context, *connect.Request[testingv1.SetLabelRequest]) (*connect.Response[testingv1.SetLabelResponse], error) {
	return connect.NewResponse(&testingv1.SetLabelResponse{Calls: 1}), nil
}

func (stubProcess) Signal(context.Context, *connect.Request[testingv1.SignalRequest]) (*connect.Response[testingv1.SignalResponse], error) {
	return connect.NewResponse(&testingv1.SignalResponse{}), nil
}

func newClient(t *testing.T) testingv1connect.ProcessClient {
	t.Helper()
	path, h := testingv1connect.NewProcessHandler(stubProcess{},
		connect.WithInterceptors(rpcconv.RequireRequestID(testingv1connect.ProcessStartProcedure)))
	mux := http.NewServeMux()
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return testingv1connect.NewProcessClient(srv.Client(), srv.URL)
}

func TestRequireRequestID(t *testing.T) {
	ctx := context.Background()
	c := newClient(t)

	// Mutating unary without the header is rejected.
	_, err := c.SetLabel(ctx, connect.NewRequest(&testingv1.SetLabelRequest{}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("SetLabel without id: code = %v, err = %v", connect.CodeOf(err), err)
	}
	d, ok := rpcconv.Detail(err)
	if !ok || d.GetCode() != wire.CodeRequestIDRequired {
		t.Fatalf("detail = %v, %v", d, ok)
	}

	// Invalid values are rejected too.
	for _, bad := range []string{"", "abc", "01ARZ3NDEKTSV4RRFFQ69G5FAU"} { // last has 'U' (not Crockford)
		req := connect.NewRequest(&testingv1.SetLabelRequest{})
		req.Header().Set(wire.HeaderRequestID, bad)
		if _, err := c.SetLabel(ctx, req); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("id %q: err = %v", bad, err)
		}
	}

	// UUID and ULID are accepted.
	for _, id := range []string{"0f8fad5b-d9cb-469f-a165-70867728950e", "01ARZ3NDEKTSV4RRFFQ69G5FAV"} {
		req := connect.NewRequest(&testingv1.SetLabelRequest{})
		req.Header().Set(wire.HeaderRequestID, id)
		if _, err := c.SetLabel(ctx, req); err != nil {
			t.Errorf("id %q: %v", id, err)
		}
	}

	// Idempotent unary and exempt procedure pass without the header.
	if _, err := c.Signal(ctx, connect.NewRequest(&testingv1.SignalRequest{})); err != nil {
		t.Errorf("Signal: %v", err)
	}
	if _, err := c.Start(ctx, connect.NewRequest(&testingv1.StartRequest{})); err != nil {
		t.Errorf("Start (exempt): %v", err)
	}

	// Streaming handlers pass through.
	s, err := c.Attach(ctx, connect.NewRequest(&testingv1.AttachRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	for s.Receive() {
	}
	if err := s.Err(); err != nil {
		t.Errorf("Attach: %v", err)
	}
	_ = s.Close()
}

func TestNewRetryableError(t *testing.T) {
	err := rpcconv.NewRetryableError(connect.CodeFailedPrecondition, "file_in_use", "msg")
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || err.Message() != "msg" {
		t.Errorf("err = %v", err)
	}
	d, ok := rpcconv.Detail(err)
	if !ok || d.GetCode() != "file_in_use" || !d.GetRetryable() {
		t.Errorf("detail = %v (ok=%v), want file_in_use retryable", d, ok)
	}
}

func TestNewErrorRetryable(t *testing.T) {
	cases := map[connect.Code]bool{
		connect.CodeUnavailable:      true,
		connect.CodeDeadlineExceeded: true,
		connect.CodeInvalidArgument:  false,
		connect.CodeNotFound:         false,
		connect.CodeInternal:         false,
		connect.CodeAborted:          false,
	}
	for code, want := range cases {
		if got := rpcconv.Retryable(code); got != want {
			t.Errorf("Retryable(%v) = %v, want %v", code, got, want)
		}
		err := rpcconv.NewError(code, "some_code", "msg")
		if connect.CodeOf(err) != code {
			t.Errorf("code = %v", connect.CodeOf(err))
		}
		d, ok := rpcconv.Detail(err)
		if !ok {
			t.Fatalf("%v: no detail", code)
		}
		if d.GetCode() != "some_code" || d.GetRetryable() != want {
			t.Errorf("%v: detail = %v", code, d)
		}
	}
	if _, ok := rpcconv.Detail(errors.New("plain")); ok {
		t.Error("plain error must have no detail")
	}
	// Detail finds the detail through wrapping.
	wrapped := errors.Join(errors.New("x"), rpcconv.NewError(connect.CodeUnavailable, "agent_unavailable", "m"))
	if d, ok := rpcconv.Detail(wrapped); !ok || d.GetCode() != "agent_unavailable" {
		t.Errorf("wrapped detail = %v, %v", d, ok)
	}
}
