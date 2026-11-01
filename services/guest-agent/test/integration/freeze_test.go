//go:build integration && linux

package integration

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/services/guest-agent/internal/events"
)

const (
	fzImage = "/var/tmp/it-fz.img"
	fzMount = "/mnt/fz"
	// autoThawEpsilon is how much earlier than the lease deadline the
	// auto-thaw may be observed.
	autoThawEpsilon = 250 * time.Millisecond
)

// freezableMounts lists the visible rw ext4/xfs/btrfs mounts with a /dev
// source, the mounts the agent would freeze.
func freezableMounts(t *testing.T) []string {
	t.Helper()
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		sep := slices.Index(fields, "-")
		if sep < 0 || len(fields) < sep+3 {
			continue
		}
		fstype, src, opts := fields[sep+1], fields[sep+2], fields[5]
		if (fstype == "ext4" || fstype == "xfs" || fstype == "btrfs") && strings.HasPrefix(src, "/dev/") && !slices.Contains(strings.Split(opts, ","), "ro") {
			out = append(out, fields[4])
		}
	}
	return out
}

// setupLoopExt4 mounts a fresh ext4 loop image at fzMount and makes sure it
// is the only filesystem the agent can freeze: in Docker Desktop any other
// ext4 mount would be the disk of the Docker VM itself.
func setupLoopExt4(t *testing.T) {
	t.Helper()
	sh(t, "mkdir -p "+fzMount+" && truncate -s 128M "+fzImage+" && mkfs.ext4 -q -F "+fzImage)
	out, err := shErr("mount -o loop " + fzImage + " " + fzMount)
	if err != nil {
		// A loop device created after the container started has no node in
		// its /dev; create the nodes and retry.
		sh(t, `for i in $(seq 0 31); do [ -e /dev/loop$i ] || mknod -m 0660 /dev/loop$i b 7 $i; done`)
		out, err = shErr("mount -o loop " + fzImage + " " + fzMount)
	}
	if err != nil {
		t.Fatalf("mount the loop image: %v\n%s", err, out)
	}
	t.Cleanup(func() {
		_, _ = shErr("fsfreeze -u " + fzMount)
		_, _ = shErr("umount " + fzMount + " && rm -f " + fzImage)
	})
	if got := freezableMounts(t); !slices.Equal(got, []string{fzMount}) {
		t.Fatalf("freezable mounts = %v, want only %s", got, fzMount)
	}
}

// writer starts a write with fsync to the loop filesystem and returns a
// channel closed when it completes.
func writer(t *testing.T, name string) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	cmd := exec.CommandContext(ctx, "dd", "if=/dev/zero", "of="+fzMount+"/"+name, "bs=4k", "count=1", "conv=fsync", "status=none")
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	go func() {
		_ = cmd.Wait()
		cancel()
		close(done)
	}()
	return done
}

// blocked reports whether done stays open for d.
func blocked(done <-chan struct{}, d time.Duration) bool {
	select {
	case <-done:
		return false
	case <-time.After(d):
		return true
	}
}

// quiesce freezes the filesystems (no Docker) with a lease of leaseMs.
func quiesce(t *testing.T, c *agentClient, leaseMs uint32) *agentv1.QuiesceResponse {
	t.Helper()
	res, err := c.sys.Quiesce(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.QuiesceRequest{
		LeaseMs: proto.Uint32(leaseMs), Docker: proto.Bool(false), Fs: proto.Bool(true),
	}))
	if err != nil {
		t.Fatalf("Quiesce: %v", err)
	}
	if !slices.Equal(res.Msg.GetFrozenMounts(), []string{fzMount}) {
		t.Fatalf("frozen mounts = %v, want [%s]", res.Msg.GetFrozenMounts(), fzMount)
	}
	return res.Msg
}

// Spec 21 item 11 (container part): FIFREEZE of a loop-mounted ext4, Thaw,
// auto-thaw by the lease deadline, thaw at agent start after SIGKILL, thaw of
// a foreign freeze. The Docker pause and the snapshot/fork belong to the pve
// stand.
func TestFreezeLoopExt4(t *testing.T) {
	setupLoopExt4(t)
	c := newClient()

	t.Run("quiesce blocks writes, thaw releases", func(t *testing.T) {
		q := quiesce(t, c, 30000)
		w := writer(t, "a")
		if !blocked(w, 2*time.Second) {
			t.Fatal("a write completed on the frozen filesystem")
		}
		res, err := c.sys.Thaw(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.ThawRequest{LeaseId: q.GetLeaseId()}))
		if err != nil {
			t.Fatalf("Thaw: %v", err)
		}
		if res.Msg.GetAutoThawed() {
			t.Errorf("Thaw = %v", res.Msg)
		}
		if blocked(w, 10*time.Second) {
			t.Fatal("the write did not complete after Thaw")
		}
	})

	t.Run("auto thaw by the deadline", func(t *testing.T) {
		after := lastSeq(t)
		q := quiesce(t, c, 3000)
		w := writer(t, "b")
		frozenAt := time.Now()
		deadline := q.GetDeadline().AsTime()
		if blocked(w, time.Until(deadline.Add(5*time.Second))) {
			t.Fatalf("not thawed %v after the deadline", time.Since(deadline))
		}
		// Not before the deadline either (same clock; a small margin for the
		// write's own completion).
		if early := time.Until(deadline); early > autoThawEpsilon {
			t.Errorf("thawed %v before the deadline", early)
		}
		t.Logf("thawed %v after Quiesce (deadline %v)", time.Since(frozenAt).Round(10*time.Millisecond), time.Until(deadline).Round(10*time.Millisecond))
		var ev agentv1.QuiesceAutoThawed
		waitEvent(t, after, events.TypeQuiesceAutoThawed, 15*time.Second, &ev, func() bool { return ev.GetLeaseId() == q.GetLeaseId() })
		res, err := c.sys.Thaw(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.ThawRequest{LeaseId: q.GetLeaseId()}))
		if err != nil {
			t.Fatalf("Thaw after the auto thaw: %v", err)
		}
		if !res.Msg.GetAutoThawed() {
			t.Errorf("Thaw = %v, want auto_thawed", res.Msg)
		}
	})

	t.Run("SIGKILL of the agent while frozen", func(t *testing.T) {
		quiesce(t, c, 60000)
		w := writer(t, "c")
		if !blocked(w, time.Second) {
			t.Fatal("a write completed on the frozen filesystem")
		}
		began := time.Now()
		kill9Agent(t)
		if blocked(w, 15*time.Second) {
			t.Fatal("the restarted agent did not thaw")
		}
		t.Logf("thawed %v after the SIGKILL", time.Since(began).Round(10*time.Millisecond))
	})

	// The probe writes to the state directory (spec 14.4): a QGA freeze
	// freezes every filesystem, the root with the state included. Here only
	// the loop filesystem can be frozen, so the state directory is moved
	// onto it for this case.
	t.Run("foreign freeze", func(t *testing.T) {
		stateOnLoop(t)
		sh(t, "fsfreeze -f "+fzMount)
		began := time.Now()
		w := writer(t, "d")
		if blocked(w, 30*time.Second) {
			t.Fatal("the agent did not thaw a foreign freeze within 30 s")
		}
		took := time.Since(began)
		t.Logf("foreign freeze thawed after %v", took.Round(10*time.Millisecond))
		// A probe starts within 5 s of the freeze and gives up after 15 s.
		if took < 14500*time.Millisecond || took > 21*time.Second {
			t.Errorf("thawed after %v, want within 15-20 s", took)
		}
		var ev agentv1.QuiesceAutoThawed
		waitEvent(t, 0, events.TypeQuiesceAutoThawed, 15*time.Second, &ev, func() bool { return ev.GetBy() == "foreign" })
	})
}

// stateOnLoop moves the agent state directory onto the loop filesystem (a
// bind mount over /var/lib/umiak-agent) with the agent stopped, and moves it
// back when the test ends.
func stateOnLoop(t *testing.T) {
	t.Helper()
	const loopState = fzMount + "/umiak-state"
	sh(t, "systemctl stop "+agentUnit)
	sh(t, "mkdir -p "+loopState+" && cp -a "+stateDir+"/. "+loopState+"/ && mount --bind "+loopState+" "+stateDir)
	sh(t, "systemctl start "+agentUnit)
	waitAgent(t)
	t.Cleanup(func() {
		_, _ = shErr("fsfreeze -u " + fzMount)
		sh(t, "systemctl stop "+agentUnit)
		sh(t, "umount "+stateDir+" && cp -a "+loopState+"/. "+stateDir+"/")
		sh(t, "systemctl reset-failed "+agentUnit+" || true; systemctl start "+agentUnit)
		waitAgent(t)
	})
}
