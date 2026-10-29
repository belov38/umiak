package gateway

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	tunnelv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/tunnel/v1"
)

// EventSink receives agent events and connection events (spec 9.6). The
// production sink is NewHTTPSink.
type EventSink interface {
	// DeliverEvents stores a batch of guest events and returns the highest
	// seq stored, which the gateway acknowledges to the agent.
	DeliverEvents(ctx context.Context, machineID string, events []*tunnelv1.Event) (ackedSeq uint64, err error)
	// DeliverConnectionEvent stores a synthetic connection event; the key is
	// (machineId, epoch, type).
	DeliverConnectionEvent(ctx context.Context, ev *tunnelv1.ConnectionEvent) error
}

// Delivery limits.
const (
	// deliverTimeout bounds one sink call.
	deliverTimeout = 30 * time.Second
	// connEventAttempts is how often a connection event is tried.
	connEventAttempts = 3
	// maxSinkResponse bounds the response body read from api.
	maxSinkResponse = 1 << 20
)

// NewHTTPSink returns a sink that POSTs binary protobuf AgentEventsRequest
// bodies to {apiURL}/internal/v1/agent-events with the gateway's service
// token. Binary, not protojson: event payloads are Any of S3/S6 types the
// gateway does not link, and protojson would have to resolve them. A nil
// client uses http.DefaultClient.
func NewHTTPSink(apiURL, serviceToken string, client *http.Client) EventSink {
	if client == nil {
		client = http.DefaultClient
	}
	return &httpSink{
		url:    strings.TrimSuffix(apiURL, "/") + "/internal/v1/agent-events",
		token:  serviceToken,
		client: client,
	}
}

type httpSink struct {
	url    string
	token  string
	client *http.Client
}

func (h *httpSink) DeliverEvents(ctx context.Context, machineID string, events []*tunnelv1.Event) (uint64, error) {
	resp, err := h.post(ctx, &tunnelv1.AgentEventsRequest{MachineId: machineID, Events: events})
	if err != nil {
		return 0, err
	}
	return resp.GetAckedSeq(), nil
}

func (h *httpSink) DeliverConnectionEvent(ctx context.Context, ev *tunnelv1.ConnectionEvent) error {
	_, err := h.post(ctx, &tunnelv1.AgentEventsRequest{
		MachineId:        ev.GetMachineId(),
		ConnectionEvents: []*tunnelv1.ConnectionEvent{ev},
	})
	return err
}

func (h *httpSink) post(ctx context.Context, body *tunnelv1.AgentEventsRequest) (*tunnelv1.AgentEventsResponse, error) {
	data, err := proto.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	req.Header.Set("Content-Type", "application/proto")
	req.Header.Set("Accept", "application/proto, application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	out, err := io.ReadAll(io.LimitReader(resp.Body, maxSinkResponse))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return nil, fmt.Errorf("agent-events: status %d: %s", resp.StatusCode, msg)
	}
	var res tunnelv1.AgentEventsResponse
	if mt, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type")); mt == "application/proto" {
		// An empty binary body is a valid ackedSeq 0.
		err = proto.Unmarshal(out, &res)
	} else {
		// An empty body without the proto content type is an error: it
		// would read as ackedSeq 0.
		if len(bytes.TrimSpace(out)) == 0 {
			return nil, fmt.Errorf("agent-events: status %d with an empty body", resp.StatusCode)
		}
		err = (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(out, &res)
	}
	if err != nil {
		return nil, fmt.Errorf("agent-events: decode response: %w", err)
	}
	return &res, nil
}

// logSink stands in for a nil Config.Sink: it logs, drops and acknowledges.
type logSink struct{ log *slog.Logger }

func (l logSink) DeliverEvents(_ context.Context, machineID string, events []*tunnelv1.Event) (uint64, error) {
	last := events[len(events)-1].GetSeq()
	l.log.Debug("gateway: no event sink, agent events dropped", "machine_id", machineID,
		"count", len(events), "last_seq", last)
	return last, nil
}

func (l logSink) DeliverConnectionEvent(_ context.Context, ev *tunnelv1.ConnectionEvent) error {
	l.log.Info("gateway: no event sink, connection event dropped", "machine_id", ev.GetMachineId(),
		"epoch", ev.GetEpoch(), "type", ev.GetType())
	return nil
}

// deliverConnectionEvent sends ev with a few retries until ctx is done.
func (g *Gateway) deliverConnectionEvent(ctx context.Context, ev *tunnelv1.ConnectionEvent) {
	wait := g.cfg.Timing.EventRetryMin
	var err error
	for attempt := 1; ; attempt++ {
		dctx, cancel := context.WithTimeout(ctx, deliverTimeout)
		err = g.sink.DeliverConnectionEvent(dctx, ev)
		cancel()
		if err == nil || ctx.Err() != nil || attempt == connEventAttempts {
			break
		}
		if !sleepCtx(ctx, wait) {
			break
		}
		wait = min(wait*2, g.cfg.Timing.EventRetryMax)
	}
	if err != nil {
		g.log.Warn("gateway: connection event not delivered", "machine_id", ev.GetMachineId(),
			"epoch", ev.GetEpoch(), "type", ev.GetType(), "err", err)
	}
}

// errPartialAck ends a Subscribe stream after the sink stored only part of a
// batch: the agent resends the rest after its acked seq on the next stream.
var errPartialAck = errors.New("sink acknowledged part of the batch, resubscribing")

// sleepCtx waits d and reports false if ctx ended first.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// pumpEvents pulls the agent's event journal and delivers it to the sink
// (spec 9.6) until the session ends, resubscribing with backoff after a
// broken stream.
func (s *session) pumpEvents() {
	ctx := s.ctx
	tm := s.g.cfg.Timing
	wait := tm.EventRetryMin
	for {
		delivered, err := s.pumpOnce(ctx)
		if ctx.Err() != nil || !s.state().serving() {
			return
		}
		if delivered {
			wait = tm.EventRetryMin
		}
		if connect.CodeOf(err) == connect.CodeResourceExhausted {
			s.log.Warn("gateway: agent sent an event above MaxEventBytes, resubscribing",
				"max_event_bytes", tm.MaxEventBytes, "err", err, "retry_in", wait)
		} else {
			s.log.Warn("gateway: event stream ended, resubscribing", "err", err, "retry_in", wait)
		}
		if !sleepCtx(ctx, wait) {
			return
		}
		wait = min(wait*2, tm.EventRetryMax)
	}
}

// pumpOnce runs one Events/Subscribe stream. Events are batched up to
// EventBatchMax events or EventBatchMaxBytes (proto size; a batch is sent
// before an event that would exceed it), or EventBatchInterval after the
// first event of the batch. A batch is retried until the sink takes it,
// without reading further from the stream; then the sink's ackedSeq is
// acknowledged to the agent. A session thus buffers at most a batch, the
// event that closed it and the one message the reader holds, each message
// at most MaxEventBytes. It reports whether any batch was delivered.
func (s *session) pumpOnce(ctx context.Context) (bool, error) {
	tm := s.g.cfg.Timing
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := s.events.Subscribe(sctx, connect.NewRequest(&tunnelv1.SubscribeRequest{}))
	if err != nil {
		return false, err
	}
	// The reader hands events over one at a time: while a batch is being
	// retried it blocks, so nothing more is read from the stream.
	evCh := make(chan *tunnelv1.Event)
	errCh := make(chan error, 1)
	var reader sync.WaitGroup
	reader.Go(func() {
		defer close(evCh)
		for stream.Receive() {
			ev := stream.Msg().GetEvent()
			if ev == nil {
				continue
			}
			select {
			case evCh <- ev:
			case <-sctx.Done():
				return
			}
		}
		errCh <- stream.Err()
	})
	defer func() {
		cancel()
		reader.Wait()
		_ = stream.Close()
	}()

	var (
		batch     []*tunnelv1.Event
		size      int // summed proto size of batch
		timer     *time.Timer
		timerC    <-chan time.Time
		delivered bool
		acked     uint64
	)
	flush := func() error {
		if timer != nil {
			timer.Stop()
			timer, timerC = nil, nil
		}
		if len(batch) == 0 {
			return nil
		}
		last := batch[len(batch)-1].GetSeq()
		n, err := s.deliverBatch(ctx, batch)
		if err != nil {
			return err
		}
		batch, size = nil, 0
		delivered = true
		if n > acked {
			if _, err := s.events.Ack(ctx, connect.NewRequest(&tunnelv1.AckRequest{Seq: n})); err != nil {
				return fmt.Errorf("Events/Ack: %w", err)
			}
			acked = n
		}
		if n < last {
			// Reading on would skip the events after n.
			return fmt.Errorf("%w (acked %d of %d)", errPartialAck, n, last)
		}
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return delivered, ctx.Err()
		case ev, ok := <-evCh:
			if !ok {
				if err := flush(); err != nil {
					return delivered, err
				}
				// The reader fills errCh before closing evCh, unless it
				// stopped because ctx ended.
				var err error
				select {
				case err = <-errCh:
				default:
					err = ctx.Err()
				}
				if err == nil {
					err = errors.New("event stream ended")
				}
				return delivered, err
			}
			n := proto.Size(ev)
			if len(batch) > 0 && size+n > tm.EventBatchMaxBytes {
				if err := flush(); err != nil {
					return delivered, err
				}
			}
			batch = append(batch, ev)
			size += n
			if len(batch) == 1 {
				timer = time.NewTimer(tm.EventBatchInterval)
				timerC = timer.C
			}
			if len(batch) >= tm.EventBatchMax || size >= tm.EventBatchMaxBytes {
				if err := flush(); err != nil {
					return delivered, err
				}
			}
		case <-timerC:
			if err := flush(); err != nil {
				return delivered, err
			}
		}
	}
}

// deliverBatch retries DeliverEvents with backoff until it succeeds or ctx
// ends. An ackedSeq above the batch's last seq would acknowledge events
// never sent, so it counts as a failure.
func (s *session) deliverBatch(ctx context.Context, batch []*tunnelv1.Event) (uint64, error) {
	tm := s.g.cfg.Timing
	wait := tm.EventRetryMin
	last := batch[len(batch)-1].GetSeq()
	for {
		dctx, cancel := context.WithTimeout(ctx, deliverTimeout)
		acked, err := s.g.sink.DeliverEvents(dctx, s.machineID, batch)
		cancel()
		if err == nil && acked > last {
			err = fmt.Errorf("sink acked seq %d beyond the batch's last seq %d", acked, last)
		}
		if err == nil {
			return acked, nil
		}
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		s.log.Warn("gateway: delivering agent events failed", "err", err, "first_seq", batch[0].GetSeq(),
			"count", len(batch), "retry_in", wait)
		if !sleepCtx(ctx, wait) {
			return 0, ctx.Err()
		}
		wait = min(wait*2, tm.EventRetryMax)
	}
}
