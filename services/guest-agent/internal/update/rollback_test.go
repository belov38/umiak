package update

import (
	"os"
	"slices"
	"testing"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

func TestRollback(t *testing.T) {
	restart := [][]string{{"reset-failed", "sbx-agent.service"}, {"start", "--no-block", "sbx-agent.service"}}

	setup := func(t *testing.T) paths.Layout {
		t.Helper()
		_, priv := testKey(t)
		l := paths.ForRoot(t.TempDir())
		for _, v := range []string{"v1", "v2", "v3"} {
			installed(t, l, v, priv)
		}
		setLinks(t, l, "v2", "v1")
		return l
	}

	t.Run("with pending", func(t *testing.T) {
		l := setup(t)
		if err := writePending(l, Pending{From: "v1", To: "v2", Deadline: time.Now().Add(time.Minute)}); err != nil {
			t.Fatal(err)
		}
		sc := &fakeSystemctl{}
		var slept []time.Duration
		if err := Rollback(l, "", sc.run, func(d time.Duration) { slept = append(slept, d) }); err != nil {
			t.Fatal(err)
		}
		if cur, prev := linkTarget(t, l.CurrentLink), linkTarget(t, l.PreviousLink); cur != "v1" || prev != "v1" {
			t.Errorf("current, previous = %q, %q; want v1, v1", cur, prev)
		}
		if bad, _ := readBadVersions(l); !slices.Equal(bad, []string{"v2"}) {
			t.Errorf("bad versions = %v", bad)
		}
		if _, err := os.Stat(l.PendingUpdateFile); !os.IsNotExist(err) {
			t.Error("pending kept")
		}
		var res rollbackResult
		if err := readRollbackResult(l, &res); err != nil || res.From != "v1" || res.To != "v2" {
			t.Errorf("rollback marker = %+v, %v", res, err)
		}
		if len(slept) != 0 {
			t.Errorf("slept %v", slept)
		}
		if !slices.EqualFunc(sc.calls, restart, slices.Equal) {
			t.Errorf("systemctl = %v, want %v", sc.calls, restart)
		}
	})

	t.Run("without pending", func(t *testing.T) {
		l := setup(t)
		sc := &fakeSystemctl{}
		var slept []time.Duration
		if err := Rollback(l, "", sc.run, func(d time.Duration) { slept = append(slept, d) }); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(slept, []time.Duration{30 * time.Second}) {
			t.Errorf("slept %v, want [30s]", slept)
		}
		if cur, prev := linkTarget(t, l.CurrentLink), linkTarget(t, l.PreviousLink); cur != "v2" || prev != "v1" {
			t.Errorf("versions changed: %q, %q", cur, prev)
		}
		if bad, _ := readBadVersions(l); len(bad) != 0 {
			t.Errorf("bad versions = %v", bad)
		}
		if _, err := os.Stat(rollbackResultFile(l)); !os.IsNotExist(err) {
			t.Error("rollback marker written")
		}
		if !slices.EqualFunc(sc.calls, restart, slices.Equal) {
			t.Errorf("systemctl = %v, want %v", sc.calls, restart)
		}
	})

	t.Run("to version", func(t *testing.T) {
		l := setup(t)
		sc := &fakeSystemctl{}
		if err := Rollback(l, "v3", sc.run, func(time.Duration) { t.Error("slept") }); err != nil {
			t.Fatal(err)
		}
		if cur, prev := linkTarget(t, l.CurrentLink), linkTarget(t, l.PreviousLink); cur != "v3" || prev != "v2" {
			t.Errorf("current, previous = %q, %q; want v3, v2", cur, prev)
		}
		want := [][]string{{"reset-failed", "sbx-agent.service"}, {"restart", "--no-block", "sbx-agent.service"}}
		if !slices.EqualFunc(sc.calls, want, slices.Equal) {
			t.Errorf("systemctl = %v, want %v", sc.calls, want)
		}
		if err := Rollback(l, "v9", sc.run, func(time.Duration) {}); err == nil {
			t.Error("rollback to a missing version succeeded")
		}
		if err := Rollback(l, "../v1", sc.run, func(time.Duration) {}); err == nil {
			t.Error("rollback to an invalid version succeeded")
		}
	})
}
