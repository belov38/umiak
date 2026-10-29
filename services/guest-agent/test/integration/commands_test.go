//go:build integration && linux

package integration

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

// Spec 21 item 1: exact output, exit codes, /dev/stdout and /dev/stderr
// reopened by user and root, exactly one start per command id.
func TestCommandsExactOutput(t *testing.T) {
	c := newClient()

	t.Run("sha256 of 8 MiB stdout", func(t *testing.T) {
		src := "/tmp/it-8mib.bin"
		sh(t, "head -c 8388608 /dev/urandom > "+src+" && chmod 0644 "+src)
		want := sha256.Sum256(readFileT(t, src))
		r := run(t, c, newID("sha"), shellSpec("cat "+src+"; exit 3", ""), 2*time.Minute)
		got := sha256.Sum256(r.stdout)
		if len(r.stdout) != 8<<20 || got != want {
			if len(r.stdout) > 16 {
				t.Logf("stdout head %q tail %q, stderr %q", r.stdout[:16], r.stdout[len(r.stdout)-16:], r.stderr)
			}
			t.Errorf("stdout: %d bytes sha256 %s, want %d bytes %s", len(r.stdout),
				hex.EncodeToString(got[:]), 8<<20, hex.EncodeToString(want[:]))
		}
		if r.exit.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED || r.exit.GetCode() != 3 {
			t.Errorf("exit = %v, want EXITED code 3", r.exit)
		}
		if r.exit.GetStdoutEnd() != 8<<20 {
			t.Errorf("stdout_end = %d", r.exit.GetStdoutEnd())
		}
	})

	for _, user := range []string{"user", "root"} {
		t.Run("dev stderr as "+user, func(t *testing.T) {
			r := run(t, c, newID("dev-"+user), shellSpec("echo out1; echo err1 >/dev/stderr; echo out2 >/dev/stdout; echo err2 1>&2; id -un", user), time.Minute)
			if got, want := string(r.stdout), "out1\nout2\n"+user+"\n"; got != want {
				t.Errorf("stdout = %q, want %q", got, want)
			}
			if got, want := string(r.stderr), "err1\nerr2\n"; got != want {
				t.Errorf("stderr = %q, want %q", got, want)
			}
			if r.exit.GetCode() != 0 {
				t.Errorf("exit = %v", r.exit)
			}
		})
	}

	t.Run("repeated start", func(t *testing.T) {
		id := newID("once")
		marker := "/tmp/" + id + ".marker"
		spec := shellSpec("echo started >> "+marker+"; sleep 2", "root")
		first := start(t, c, id, spec)
		again, err := c.proc.Start(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.StartRequest{CommandId: id, Spec: spec}))
		if err != nil {
			t.Fatalf("repeated Start: %v", err)
		}
		if again.Msg.GetCreated() {
			t.Error("repeated Start reports created")
		}
		if again.Msg.GetCommand().GetPid() != first.GetPid() {
			t.Errorf("pid %d, want %d", again.Msg.GetCommand().GetPid(), first.GetPid())
		}
		_, err = c.proc.Start(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.StartRequest{CommandId: id, Spec: shellSpec("echo other", "root")}))
		if !isCode(err, connect.CodeAlreadyExists) {
			t.Errorf("Start with another spec = %v, want already_exists", err)
		}
		waitExited(t, c, id, time.Minute)
		if got := string(readFileT(t, marker)); got != "started\n" {
			t.Errorf("marker = %q, want one start", got)
		}
	})

	// SIGKILL of the agent around Start, at several points between the
	// durable record and the answer: a retry with the same id must never start
	// the command twice. The timing cannot be pinned from outside, so it is
	// swept with increasing delays.
	t.Run("start across agent SIGKILL", func(t *testing.T) {
		for i, delay := range []time.Duration{0, 2 * time.Millisecond, 5 * time.Millisecond, 10 * time.Millisecond, 25 * time.Millisecond} {
			id := newID(fmt.Sprintf("kill%d", i))
			marker := "/tmp/" + id + ".marker"
			spec := shellSpec("echo started >> "+marker+"; sleep 1", "root")
			pid := mainPID(t)
			var wg sync.WaitGroup
			var firstErr error
			var firstCreated bool
			wg.Go(func() {
				res, err := newClient().proc.Start(tctx(t, 10*time.Second), connect.NewRequest(&agentv1.StartRequest{CommandId: id, Spec: spec}))
				firstErr = err
				if err == nil {
					firstCreated = res.Msg.GetCreated()
				}
			})
			time.Sleep(delay)
			sh(t, fmt.Sprintf("kill -9 %d", pid))
			wg.Wait()
			waitRestarted(t, pid)
			res, err := c.proc.Start(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.StartRequest{CommandId: id, Spec: spec}))
			if err != nil {
				t.Fatalf("retry %d: Start: %v", i, err)
			}
			t.Logf("delay %v: first Start err=%v created=%v; retry created=%v", delay, firstErr, firstCreated, res.Msg.GetCreated())
			info := waitExited(t, c, id, time.Minute)
			if got := string(readFileT(t, marker)); got != "started\n" {
				t.Errorf("delay %v: marker = %q (created on retry: %v, exit %v), want exactly one start",
					delay, got, res.Msg.GetCreated(), info.GetExit())
			}
			if _, err := os.Stat(cmdDir(id) + "/shim.json"); err != nil {
				t.Errorf("delay %v: shim.json: %v", delay, err)
			}
			if n := unitStarts(t, id); n != 1 {
				t.Errorf("delay %v: the shim unit was started %d times, want 1", delay, n)
			}
		}
	})
}

// unitStarts counts the "Started" messages of the shim unit of command id
// in the journal. -m merges the journals of all machine ids: the identity
// test changes the machine id under a running journald.
func unitStarts(t *testing.T, id string) int {
	t.Helper()
	out := sh(t, "journalctl -m --no-pager -o cat -u "+supervisor.UnitName(id))
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "Started ") {
			n++
		}
	}
	return n
}

// readFileT returns the content of path or fails the test.
func readFileT(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// isCode reports whether err is a Connect error with code.
func isCode(err error, code connect.Code) bool {
	return err != nil && connect.CodeOf(err) == code
}

// cgroupOf returns the cgroup v2 path of pid.
func cgroupOf(t *testing.T, pid string) string {
	t.Helper()
	b, err := os.ReadFile("/proc/" + pid + "/cgroup")
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(strings.TrimPrefix(string(b), "0::"))
}

// Spec 21 item 6: leftovers outlive the main process and are reported; Kill
// (cgroup.kill), a signal after the exit (per process) and
// on_exit=KILL_LEFTOVERS end them. Checks the payload cgroup of the shim
// (CLONE_INTO_CGROUP) and its populated tracking on the way.
func TestLeftovers(t *testing.T) {
	c := newClient()

	t.Run("kept, then Kill", func(t *testing.T) {
		id := newID("left")
		r := run(t, c, id, shellSpec("sleep 1001 & setsid sleep 1011 & echo started", "user"), time.Minute)
		if string(r.stdout) != "started\n" || r.exit.GetCode() != 0 {
			t.Fatalf("run = %q %v", r.stdout, r.exit)
		}
		left := pids("sleep 1001")
		daemon := pids("sleep 1011")
		if len(left) != 1 || len(daemon) != 1 {
			t.Fatalf("leftovers: %v %v", left, daemon)
		}
		want := "/sbx-cmd.slice/" + supervisor.UnitName(id) + "/payload"
		for _, p := range append(left, daemon...) {
			if cg := cgroupOf(t, p); !strings.HasSuffix(cg, want) {
				t.Errorf("leftover %s in cgroup %s, want .../%s", p, cg, want)
			}
		}
		eventually(t, 10*time.Second, "has_leftovers", func() bool { return get(t, c, id).GetHasLeftovers() })
		if _, err := c.proc.Kill(tctx(t, 10*time.Second), connect.NewRequest(&agentv1.KillRequest{CommandId: id})); err != nil {
			t.Fatalf("Kill: %v", err)
		}
		eventually(t, 15*time.Second, "the leftovers to die", func() bool {
			return len(pids("sleep 1001")) == 0 && len(pids("sleep 1011")) == 0
		})
		eventually(t, 15*time.Second, "has_leftovers to clear", func() bool { return !get(t, c, id).GetHasLeftovers() })
		info := get(t, c, id)
		if info.GetExit().GetCode() != 0 || info.GetExit().GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED {
			t.Errorf("exit after Kill of leftovers = %v, want the original EXITED 0", info.GetExit())
		}
	})

	t.Run("signal after exit", func(t *testing.T) {
		id := newID("leftsig")
		run(t, c, id, shellSpec("sleep 1003 & echo started", "user"), time.Minute)
		if len(pids("sleep 1003")) != 1 {
			t.Fatal("no leftover")
		}
		eventually(t, 10*time.Second, "has_leftovers", func() bool { return get(t, c, id).GetHasLeftovers() })
		if _, err := c.proc.Signal(tctx(t, 10*time.Second), connect.NewRequest(&agentv1.SignalRequest{CommandId: id, Signal: "SIGTERM"})); err != nil {
			t.Fatalf("Signal: %v", err)
		}
		eventually(t, 15*time.Second, "SIGTERM to reach the leftover", func() bool { return len(pids("sleep 1003")) == 0 })
		eventually(t, 15*time.Second, "has_leftovers to clear", func() bool { return !get(t, c, id).GetHasLeftovers() })
	})

	t.Run("KILL_LEFTOVERS", func(t *testing.T) {
		id := newID("leftkill")
		spec := shellSpec("sleep 1002 & echo started", "user")
		spec.OnExit = agentv1.OnExit_ON_EXIT_KILL_LEFTOVERS
		run(t, c, id, spec, time.Minute)
		eventually(t, 10*time.Second, "the leftover to be killed at exit", func() bool { return len(pids("sleep 1002")) == 0 })
		eventually(t, 10*time.Second, "has_leftovers false", func() bool { return !get(t, c, id).GetHasLeftovers() })
	})
}

// Spec 21 item 7: timeout_ms gives KILLED/TIMEOUT; a command over its memory
// limit gives KILLED/OOM and the agent lives on.
func TestTimeoutAndOOM(t *testing.T) {
	c := newClient()

	t.Run("timeout", func(t *testing.T) {
		spec := shellSpec("echo begin; sleep 30", "user")
		spec.TimeoutMs = 1000
		began := time.Now()
		r := run(t, c, newID("timeout"), spec, time.Minute)
		if r.exit.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_KILLED || r.exit.GetReason() != agentv1.ExitReason_EXIT_REASON_TIMEOUT {
			t.Errorf("exit = %v, want KILLED/TIMEOUT", r.exit)
		}
		if d := time.Since(began); d > 20*time.Second {
			t.Errorf("timeout took %v", d)
		}
	})

	t.Run("oom", func(t *testing.T) {
		pid := mainPID(t)
		// The limit is set on the slice of all commands, without swap, so
		// the payload's 512 MiB cannot fit.
		sh(t, "systemctl set-property --runtime sbx-cmd.slice MemoryMax=64M MemorySwapMax=0")
		t.Cleanup(func() {
			_, _ = shErr("systemctl set-property --runtime sbx-cmd.slice MemoryMax=infinity MemorySwapMax=infinity")
		})
		r := run(t, c, newID("oom"), &agentv1.CommandSpec{
			Cmd:  &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: []string{"python3", "-c", "b=bytearray(512<<20)\nfor i in range(0, len(b), 4096): b[i] = 1"}}},
			User: "user",
		}, 2*time.Minute)
		if r.exit.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_KILLED || r.exit.GetReason() != agentv1.ExitReason_EXIT_REASON_OOM {
			t.Errorf("exit = %v, want KILLED/OOM", r.exit)
		}
		if mainPID(t) != pid {
			t.Error("the agent restarted during the OOM")
		}
		waitAgent(t)
	})
}
