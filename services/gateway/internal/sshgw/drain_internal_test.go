package sshgw

import (
	"context"
	"slices"
	"strconv"
	"testing"
	"time"
)

func warning(n int) string {
	return "sbx: gateway restarting, this SSH session will close in " + strconv.Itoa(n) + " min; reconnect to continue"
}

func drainServer(t *testing.T, clk *fakeClock, mod func(*Config)) *Server {
	t.Helper()
	return newUnitServer(t, func(c *Config) {
		c.Clock = clk
		c.DrainDeadline = 15 * time.Minute
		if mod != nil {
			mod(c)
		}
	})
}

func expectMessages(t *testing.T, ft *fakeTarget, want ...string) {
	t.Helper()
	if got := ft.messages(); !slices.Equal(got, want) {
		t.Fatalf("messages %q, want %q", got, want)
	}
	for _, n := range ft.allNotes() {
		if !n.interactiveOnly {
			t.Fatalf("drain warning %q not limited to interactive channels", n.msg)
		}
	}
}

func TestDrainWarnings(t *testing.T) {
	clk := newFakeClock()
	s := drainServer(t, clk, nil)
	ft := userTarget("u1", "usr_1", "team_1")
	s.register(ft)
	s.Drain(clk.Now())
	expectMessages(t, ft, warning(15))

	clk.Advance(14*time.Minute - time.Second)
	expectMessages(t, ft, warning(15))
	clk.Advance(time.Second)
	expectMessages(t, ft, warning(15), warning(1))
	clk.Advance(time.Minute - time.Second)
	if ft.closedWith() != "" {
		t.Fatal("closed before the deadline")
	}
	clk.Advance(time.Second)
	if ft.closedWith() != reasonDrain {
		t.Fatalf("close reason %q at the deadline", ft.closedWith())
	}
	expectMessages(t, ft, warning(15), warning(1))

	// A session accepted during the drain gets the same deadline.
	clk2 := newFakeClock()
	s2 := drainServer(t, clk2, nil)
	s2.Drain(clk2.Now())
	clk2.Advance(2*time.Minute + 30*time.Second)
	late := userTarget("late", "usr_2", "team_1")
	s2.register(late)
	expectMessages(t, late, warning(13))
	clk2.Advance(11*time.Minute + 30*time.Second)
	expectMessages(t, late, warning(13), warning(1))
	clk2.Advance(time.Minute)
	if late.closedWith() != reasonDrain {
		t.Fatalf("late session: close reason %q", late.closedWith())
	}

	// A session that ends stops its timers.
	clk3 := newFakeClock()
	s3 := drainServer(t, clk3, nil)
	gone := userTarget("gone", "usr_3", "team_1")
	s3.register(gone)
	s3.Drain(clk3.Now())
	s3.unregister(gone)
	if n := clk3.pending(); n != 0 {
		t.Fatalf("%d timers left after the session ended", n)
	}
	clk3.Advance(time.Hour)
	if gone.closedWith() != "" {
		t.Fatal("a removed session was closed")
	}
}

func TestDrainShortNotice(t *testing.T) {
	clk := newFakeClock()
	s := drainServer(t, clk, nil)
	ft := userTarget("u1", "usr_1", "team_1")
	s.register(ft)
	// 40 s are left when the deadline becomes known: one message.
	s.Drain(clk.Now().Add(-15*time.Minute + 40*time.Second))
	expectMessages(t, ft, warning(1))
	clk.Advance(39 * time.Second)
	if ft.closedWith() != "" {
		t.Fatal("closed early")
	}
	clk.Advance(time.Second)
	if ft.closedWith() != reasonDrain {
		t.Fatalf("close reason %q", ft.closedWith())
	}
	expectMessages(t, ft, warning(1))

	// A deadline already passed closes at once, without a message.
	clk2 := newFakeClock()
	s2 := drainServer(t, clk2, nil)
	old := userTarget("old", "usr_1", "team_1")
	s2.register(old)
	s2.Drain(clk2.Now().Add(-16 * time.Minute))
	if old.closedWith() != reasonDrain || len(old.messages()) != 0 {
		t.Fatalf("passed deadline: reason %q, messages %q", old.closedWith(), old.messages())
	}
}

func TestOwnerDrainDeadline(t *testing.T) {
	clk := newFakeClock()
	insts := &fakeInstances{}
	s := drainServer(t, clk, func(c *Config) { c.Instances = insts })
	viaA := userTarget("via-a", "usr_1", "team_1")
	viaA.owner = "gw-a"
	viaB := userTarget("via-b", "usr_2", "team_1")
	viaB.owner = "gw-b"
	for _, ft := range []*fakeTarget{viaA, viaB} {
		s.register(ft)
	}
	// Not draining yet: nothing happens.
	insts.set("gw-a", nil)
	s.InstanceChanged(context.Background(), "gw-a")
	if len(viaA.messages()) != 0 {
		t.Fatal("warning without a drain")
	}

	started := clk.Now().Add(-10 * time.Minute)
	insts.set("gw-a", &started)
	s.InstanceChanged(context.Background(), "gw-a")
	// The deadline is now + 5 min.
	expectMessages(t, viaA, warning(5))
	expectMessages(t, viaB)
	// A repeated notification does not warn again.
	s.InstanceChanged(context.Background(), "")
	expectMessages(t, viaA, warning(5))
	if got := insts.readIDs(); !slices.Equal(got, []string{"gw-a", "gw-a", "gw-a", "gw-b"}) {
		t.Fatalf("instance reads %q", got)
	}

	// The own drain starts later: its deadline is later, nothing changes.
	clk.Advance(time.Minute)
	s.Drain(clk.Now())
	expectMessages(t, viaA, warning(5))
	expectMessages(t, viaB, warning(15))

	clk.Advance(3 * time.Minute)
	expectMessages(t, viaA, warning(5), warning(1))
	clk.Advance(time.Minute - time.Second)
	if viaA.closedWith() != "" {
		t.Fatal("closed early")
	}
	clk.Advance(time.Second)
	if viaA.closedWith() != reasonDrain {
		t.Fatalf("close reason %q at the owner deadline", viaA.closedWith())
	}
	if viaB.closedWith() != "" {
		t.Fatal("the other session closed at the owner deadline")
	}

	// An owner that drains earlier than the own drain moves the deadline
	// earlier again: a new warning and a new schedule.
	earlier := clk.Now().Add(-14 * time.Minute)
	insts.set("gw-b", &earlier)
	s.InstanceChanged(context.Background(), "gw-b")
	expectMessages(t, viaB, warning(15), warning(1))
	clk.Advance(time.Minute)
	if viaB.closedWith() != reasonDrain {
		t.Fatalf("close reason %q", viaB.closedWith())
	}

	// A deleted instance is ignored.
	s.InstanceChanged(context.Background(), "gw-gone")
}

func TestMachineChanged(t *testing.T) {
	clk := newFakeClock()
	insts := &fakeInstances{}
	started := clk.Now().Add(-5 * time.Minute)
	insts.set("gw-a", &started)
	owners := fakeOwners{}
	s := drainServer(t, clk, func(c *Config) {
		c.Instances = insts
		c.Owners = owners
	})
	ft := userTarget("u1", "usr_1", "team_1") // machine m-u1
	ft.owner = "gw-a"
	other := userTarget("u2", "usr_2", "team_1") // machine m-u2
	other.owner = "gw-a"
	s.register(ft)
	s.register(other)

	// Still on gw-a: its row is not read.
	owners["m-u1"] = "gw-a"
	s.MachineChanged(context.Background(), "m-u1")
	if len(insts.readIDs()) != 0 || len(ft.messages()) != 0 {
		t.Fatalf("reads %q, messages %q", insts.readIDs(), ft.messages())
	}
	// A failing lookup changes nothing.
	owners["m-u1"] = "error"
	s.MachineChanged(context.Background(), "m-u1")
	if len(insts.readIDs()) != 0 {
		t.Fatal("instance read after a failed lookup")
	}
	// Moved to gw-b: gw-a is re-read and drains.
	owners["m-u1"] = "gw-b"
	s.MachineChanged(context.Background(), "m-u1")
	if got := insts.readIDs(); !slices.Equal(got, []string{"gw-a"}) {
		t.Fatalf("instance reads %q", got)
	}
	expectMessages(t, ft, warning(10))
	// The other session's stream runs through gw-a too.
	expectMessages(t, other, warning(10))

	// "" checks every machine; a machine without an owner counts as moved.
	clk2 := newFakeClock()
	insts2 := &fakeInstances{}
	s2 := drainServer(t, clk2, func(c *Config) {
		c.Instances = insts2
		c.Owners = fakeOwners{}
	})
	x := userTarget("x", "usr_1", "team_1")
	x.owner = "gw-c"
	s2.register(x)
	s2.MachineChanged(context.Background(), "")
	if got := insts2.readIDs(); !slices.Equal(got, []string{"gw-c"}) {
		t.Fatalf("instance reads %q", got)
	}

	// The queued form runs on the worker.
	clk3 := newFakeClock()
	insts3 := &fakeInstances{}
	s3 := drainServer(t, clk3, func(c *Config) {
		c.Instances = insts3
		c.Owners = fakeOwners{}
	})
	y := userTarget("y", "usr_1", "team_1")
	y.owner = "gw-d"
	s3.register(y)
	s3.NotifyMachine("m-y")
	s3.NotifyInstance("gw-e")
	flushJobs(t, s3)
	if got := insts3.readIDs(); !slices.Equal(got, []string{"gw-d", "gw-e"}) {
		t.Fatalf("queued reads %q", got)
	}
}
