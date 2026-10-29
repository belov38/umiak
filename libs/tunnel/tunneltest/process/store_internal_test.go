package process

import (
	"testing"
	"time"

	testingv1 "github.com/belov38/boat-dev-clone/libs/tunnel/tunneltest/testpb/sbx/testing/v1"
)

// Starts counts generator launches, not Start calls: a second generator for
// the same command (the bug it guards against) shows as 2.
func TestStartsCountsGenerators(t *testing.T) {
	s := NewStore(Options{})
	t.Cleanup(s.Close)
	c, created, err := s.start("dup", &testingv1.CommandSpec{Lines: 2, LineBytes: 32})
	if err != nil || !created {
		t.Fatalf("start = %v, %v", created, err)
	}
	if _, created, _ := s.start("dup", &testingv1.CommandSpec{Lines: 2, LineBytes: 32}); created {
		t.Fatal("second start created a command")
	}
	if n := s.Starts("dup"); n != 1 {
		t.Fatalf("Starts = %d, want 1", n)
	}
	c.launch(0)
	if n := s.Starts("dup"); n != 2 {
		t.Fatalf("Starts after a second generator = %d, want 2", n)
	}
	select {
	case <-c.done:
	case <-time.After(10 * time.Second):
		t.Fatal("command did not exit")
	}
}
