package gateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
)

func TestHTTPSink(t *testing.T) {
	var (
		mu       sync.Mutex
		reqs     []*tunnelv1.AgentEventsRequest
		fail     bool
		empty    bool
		jsonResp bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/v1/agent-events" {
			http.Error(w, "bad route "+r.Method+" "+r.URL.Path, http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer svc-token" || r.Header.Get("Content-Type") != "application/proto" ||
			r.Header.Get("Accept") != "application/proto, application/json" {
			http.Error(w, "bad headers", http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req tunnelv1.AgentEventsRequest
		if err := proto.Unmarshal(body, &req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		reqs = append(reqs, &req)
		f, emp, js := fail, empty, jsonResp
		mu.Unlock()
		if f {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		if emp {
			w.WriteHeader(http.StatusOK)
			return
		}
		var acked uint64
		for _, ev := range req.GetEvents() {
			acked = max(acked, ev.GetSeq())
		}
		res := &tunnelv1.AgentEventsResponse{AckedSeq: acked}
		if js {
			out, _ := protojson.Marshal(res)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(out)
			return
		}
		out, _ := proto.Marshal(res)
		w.Header().Set("Content-Type", "application/proto")
		_, _ = w.Write(out)
	}))
	defer srv.Close()

	sink := NewHTTPSink(srv.URL+"/", "svc-token", srv.Client())
	ctx := context.Background()
	// The payload type is not linked into the gateway: the sink must not
	// need to resolve it (spec 9.6, 10.2).
	payload := &anypb.Any{TypeUrl: "type.googleapis.com/umiak.agent.v1.Unknown", Value: []byte{0x0a, 0x03, 'a', 'b', 'c'}}
	acked, err := sink.DeliverEvents(ctx, "m-1", []*tunnelv1.Event{{Seq: 4, Type: "a", Payload: payload}, {Seq: 5, Type: "b"}})
	if err != nil || acked != 5 {
		t.Fatalf("DeliverEvents = %d, %v", acked, err)
	}
	if err := sink.DeliverConnectionEvent(ctx, &tunnelv1.ConnectionEvent{MachineId: "m-1", Epoch: 3, Type: "connected"}); err != nil {
		t.Fatalf("DeliverConnectionEvent: %v", err)
	}
	mu.Lock()
	if len(reqs) != 2 || reqs[0].GetMachineId() != "m-1" || len(reqs[0].GetEvents()) != 2 ||
		reqs[1].GetMachineId() != "m-1" || len(reqs[1].GetConnectionEvents()) != 1 ||
		reqs[1].GetConnectionEvents()[0].GetEpoch() != 3 {
		t.Fatalf("requests = %v", reqs)
	}
	if got := reqs[0].GetEvents()[0].GetPayload(); !proto.Equal(got, payload) {
		t.Fatalf("payload = %v, want %v", got, payload)
	}
	jsonResp = true
	mu.Unlock()
	// A protojson response is accepted too.
	if acked, err := sink.DeliverEvents(ctx, "m-1", []*tunnelv1.Event{{Seq: 6}}); err != nil || acked != 6 {
		t.Fatalf("DeliverEvents with a JSON response = %d, %v", acked, err)
	}
	mu.Lock()
	fail = true
	mu.Unlock()
	if _, err := sink.DeliverEvents(ctx, "m-1", []*tunnelv1.Event{{Seq: 6}}); err == nil {
		t.Fatal("DeliverEvents must fail on 503")
	}
	if err := sink.DeliverConnectionEvent(ctx, &tunnelv1.ConnectionEvent{MachineId: "m-1"}); err == nil {
		t.Fatal("DeliverConnectionEvent must fail on 503")
	}
	// A 2xx without a body would read as ackedSeq 0: it is an error.
	mu.Lock()
	fail, empty = false, true
	mu.Unlock()
	if acked, err := sink.DeliverEvents(ctx, "m-1", []*tunnelv1.Event{{Seq: 6}}); err == nil {
		t.Fatalf("DeliverEvents with an empty 200 body = %d, want an error", acked)
	}
}
