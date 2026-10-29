package agent

import (
	"context"
	"errors"
	"runtime"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"
)

// defaultTCPDeadline applies when Drain carries no tcp_deadline (spec 7).
const defaultTCPDeadline = 2 * time.Minute

// tunnelPackage is the proto package the library itself serves.
var tunnelPackage = strings.TrimSuffix(wire.ServicePrefixTunnel, ".")

// controlService implements sbx.tunnel.v1.Control.
type controlService struct{ c *Client }

func (s controlService) Info(ctx context.Context, _ *connect.Request[tunnelv1.InfoRequest]) (*connect.Response[tunnelv1.InfoResponse], error) {
	var out *tunnelv1.InfoResponse
	if s.c.cfg.Info != nil {
		if got := s.c.cfg.Info(ctx); got != nil {
			out = proto.CloneOf(got)
		}
	}
	if out == nil {
		out = &tunnelv1.InfoResponse{
			AgentVersion: s.c.cfg.Identity.Version,
			Os:           runtime.GOOS,
			Arch:         runtime.GOARCH,
		}
	}
	if !slices.Contains(out.ProtoPackages, tunnelPackage) {
		out.ProtoPackages = append(out.ProtoPackages, tunnelPackage)
	}
	return connect.NewResponse(out), nil
}

func (s controlService) SetToken(_ context.Context, req *connect.Request[tunnelv1.SetTokenRequest]) (*connect.Response[tunnelv1.SetTokenResponse], error) {
	tok := req.Msg.GetToken()
	if len(tok) != wire.SecretLen {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("token must be 32 bytes"))
	}
	s.c.setToken(tok)
	return connect.NewResponse(&tunnelv1.SetTokenResponse{}), nil
}

func (s controlService) Drain(ctx context.Context, req *connect.Request[tunnelv1.DrainRequest]) (*connect.Response[tunnelv1.DrainResponse], error) {
	deadline := req.Msg.GetTcpDeadline().AsDuration()
	if req.Msg.GetTcpDeadline() == nil || deadline <= 0 {
		deadline = defaultTCPDeadline
	}
	s.c.requestDrain(connFromContext(ctx), req.Msg.GetReason(), deadline)
	return connect.NewResponse(&tunnelv1.DrainResponse{}), nil
}
