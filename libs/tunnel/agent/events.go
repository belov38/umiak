package agent

import (
	"context"

	"connectrpc.com/connect"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
)

// readBatch is the most events read from the journal per Read call.
const readBatch = 100

// EventJournal is the agent's durable event journal (spec 9.6), owned by S3.
type EventJournal interface {
	// AckedSeq returns the highest seq acknowledged by the gateway.
	AckedSeq() uint64
	// Read blocks until at least one event with seq > after exists or ctx is
	// done, and returns up to limit events in seq order.
	Read(ctx context.Context, after uint64, limit int) ([]*tunnelv1.Event, error)
	// Ack marks events up to and including seq as delivered.
	Ack(ctx context.Context, seq uint64) error
}

// emptyJournal is used when Config.Journal is nil: nothing is ever read.
type emptyJournal struct{}

func (emptyJournal) AckedSeq() uint64 { return 0 }

func (emptyJournal) Read(ctx context.Context, _ uint64, _ int) ([]*tunnelv1.Event, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (emptyJournal) Ack(context.Context, uint64) error { return nil }

// eventsService implements sbx.tunnel.v1.Events.
type eventsService struct{ j EventJournal }

func (s eventsService) Subscribe(ctx context.Context, req *connect.Request[tunnelv1.SubscribeRequest], stream *connect.ServerStream[tunnelv1.SubscribeResponse]) error {
	after := s.j.AckedSeq()
	if req.Msg.AfterSeq != nil {
		after = req.Msg.GetAfterSeq()
	}
	// Send the response headers now: Connect clients wait for them before
	// the call returns, and the journal may stay empty for a long time.
	if err := stream.Send(nil); err != nil {
		return err
	}
	for {
		evs, err := s.j.Read(ctx, after, readBatch)
		if err != nil {
			if ctx.Err() != nil {
				return connect.NewError(connect.CodeCanceled, ctx.Err())
			}
			return connect.NewError(connect.CodeInternal, err)
		}
		for _, ev := range evs {
			if err := stream.Send(&tunnelv1.SubscribeResponse{Event: ev}); err != nil {
				return err
			}
			after = ev.GetSeq()
		}
	}
}

func (s eventsService) Ack(ctx context.Context, req *connect.Request[tunnelv1.AckRequest]) (*connect.Response[tunnelv1.AckResponse], error) {
	if err := s.j.Ack(ctx, req.Msg.GetSeq()); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&tunnelv1.AckResponse{}), nil
}
