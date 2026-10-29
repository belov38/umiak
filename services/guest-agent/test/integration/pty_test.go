//go:build integration && linux

package integration

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
)

// ptySpec returns an interactive bash on a PTY run as user.
func ptySpec(user string) *agentv1.CommandSpec {
	return &agentv1.CommandSpec{
		Cmd:  &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: []string{"/bin/bash", "--noprofile", "--norc", "-i"}}},
		User: user,
		Env:  map[string]string{"PS1": "$ "},
		Pty:  &agentv1.Pty{Cols: 80, Rows: 24},
	}
}

// ptyInput is one writer of PTY input with its own sequence.
type ptyInput struct {
	c       *agentClient
	id      string
	session string
	seq     uint64
}

func newPTYInput(c *agentClient, id string) *ptyInput {
	return &ptyInput{c: c, id: id, session: uuid.NewString()}
}

// send writes data with the next seq and returns whether it was applied.
func (p *ptyInput) send(t *testing.T, data string) bool {
	t.Helper()
	p.seq++
	return p.sendSeq(t, p.seq, data)
}

// sendSeq writes data with an explicit seq.
func (p *ptyInput) sendSeq(t *testing.T, seq uint64, data string) bool {
	t.Helper()
	res, err := p.c.proc.SendInput(tctx(t, 10*time.Second), connect.NewRequest(&agentv1.SendInputRequest{
		CommandId: p.id, InputSessionId: p.session, Seq: seq, Data: []byte(data),
	}))
	if err != nil {
		t.Fatalf("SendInput %s seq %d: %v", p.id, seq, err)
	}
	return res.Msg.GetApplied()
}

// ptyOutput returns the whole PTY log of id read from offset 0.
func ptyOutput(t *testing.T, c *agentClient, id string) string {
	t.Helper()
	return string(attach(t, c, &agentv1.AttachRequest{CommandId: id}, false).pty)
}

// waitPTY waits until the PTY log of id contains want.
func waitPTY(t *testing.T, c *agentClient, id, want string) string {
	t.Helper()
	var out string
	eventually(t, 15*time.Second, "PTY output "+want, func() bool {
		out = ptyOutput(t, c, id)
		return strings.Contains(out, want)
	})
	return out
}

// Spec 21 item 5: resize, duplicate input seq, idle close (pty_idle
// shortened to 3 s by the test-only [process] pty_idle key).
func TestPTY(t *testing.T) {
	c := newClient()

	t.Run("resize and duplicate seq", func(t *testing.T) {
		id := newID("pty")
		start(t, c, id, ptySpec("user"))
		in := newPTYInput(c, id)
		in.send(t, "stty size\n")
		waitPTY(t, c, id, "24 80")

		if _, err := c.proc.Update(tctx(t, 10*time.Second), connect.NewRequest(&agentv1.UpdateRequest{CommandId: id, Cols: 132, Rows: 43})); err != nil {
			t.Fatalf("Update: %v", err)
		}
		in.send(t, "stty size\n")
		waitPTY(t, c, id, "43 132")

		if !in.send(t, "echo dup-$((40+2))\n") {
			t.Fatal("first send not applied")
		}
		if in.sendSeq(t, in.seq, "echo dup-$((40+2))\n") {
			t.Error("a repeated seq was applied again")
		}
		in.send(t, "echo done-$((1+1))\n")
		out := waitPTY(t, c, id, "done-2")
		if n := countLines(out, "dup-42"); n != 1 {
			t.Errorf("dup-42 printed %d times, want 1:\n%s", n, out)
		}

		// A PTY command of a non-root user reopens its terminal.
		in.send(t, "echo tty-ok-$((2+3)) >/dev/stderr; echo rc=$?\n")
		out = waitPTY(t, c, id, "rc=")
		if !strings.Contains(out, "tty-ok-5") || strings.Contains(out, "Permission denied") {
			t.Errorf("echo >/dev/stderr on the PTY as user:\n%s", out)
		}

		in.send(t, "exit 4\n")
		info := waitExited(t, c, id, 30*time.Second)
		if info.GetExit().GetCode() != 4 {
			t.Errorf("exit = %v, want code 4", info.GetExit())
		}
	})

	t.Run("idle close", func(t *testing.T) {
		withConfig(t, "[process]\npty_idle = \"3s\"\n")
		after := lastSeq(t)
		id := newID("ptyidle")
		start(t, c, id, ptySpec("user"))
		time.Sleep(2 * time.Second)
		if st := get(t, c, id).GetState(); st != agentv1.CommandState_COMMAND_STATE_RUNNING {
			t.Fatalf("state at 2 s = %v, want RUNNING", st)
		}
		info := waitExited(t, c, id, 30*time.Second)
		if info.GetExit().GetReason() != agentv1.ExitReason_EXIT_REASON_PTY_IDLE {
			t.Errorf("exit = %v, want reason PTY_IDLE", info.GetExit())
		}
		var closed agentv1.PtyClosed
		waitEvent(t, after, events.TypePtyClosed, 10*time.Second, &closed, func() bool { return closed.GetCommandId() == id })
		if closed.GetReason() != agentv1.ExitReason_EXIT_REASON_PTY_IDLE {
			t.Errorf("pty.closed = %v", &closed)
		}
	})
}

// csi matches the terminal control sequences bash writes (bracketed paste
// mode and the like).
var csi = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

// countLines counts the lines of terminal output out that read line once
// control sequences and carriage returns are removed.
func countLines(out, line string) int {
	n := 0
	for _, l := range strings.Split(csi.ReplaceAllString(out, ""), "\n") {
		if strings.ReplaceAll(l, "\r", "") == line {
			n++
		}
	}
	return n
}
