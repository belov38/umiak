package desktop

import (
	"context"
	"testing"
)

type fakeSCM struct {
	state         uint32
	starts, stops int
}

func (f *fakeSCM) Query() (uint32, error) { return f.state, nil }
func (f *fakeSCM) Start() error           { f.starts++; f.state = 4; return nil }
func (f *fakeSCM) Stop() error            { f.stops++; f.state = 1; return nil }
func TestServiceControlIsIdempotentAndCancellable(t *testing.T) {
	f := &fakeSCM{state: 1}
	ctx := context.Background()
	for range 2 {
		if e := controlService(ctx, f, "start"); e != nil {
			t.Fatal(e)
		}
	}
	if e := controlService(ctx, f, "restart"); e != nil {
		t.Fatal(e)
	}
	if f.starts != 2 || f.stops != 1 {
		t.Fatalf("SCM start=%d stop=%d", f.starts, f.stops)
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	cancel()
	if e := controlService(cancelCtx, f, "stop"); e == nil {
		t.Fatal("cancel ignored")
	}
}
