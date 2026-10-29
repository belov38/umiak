//go:build integration && linux

package integration

import (
	"fmt"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// commandSeconds is the run time of the command that outlives the agent
// restarts.
const commandSeconds = 60

// Spec 21 item 2: `systemctl restart` and SIGKILL of the agent during a
// running command and an open PTY: the command lives on, attach continues
// by offset, the exit is right, the PTY keeps its scrollback.
func TestAgentRestartKeepsCommand(t *testing.T) {
	c := newClient()
	id := newID("long")
	start(t, c, id, shellSpec(fmt.Sprintf("for i in $(seq 1 %d); do echo line-$i; sleep 1; done; exit 7", commandSeconds), ""))
	ptyID := newID("ptylong")
	start(t, c, ptyID, ptySpec("user"))
	in := newPTYInput(c, ptyID)
	in.send(t, "echo before-$((10+1))\n")
	waitPTY(t, c, ptyID, "before-11")

	var stdout []byte
	var offset uint64
	readMore := func(stage string) {
		r := attach(t, newClient(), &agentv1.AttachRequest{CommandId: id, StdoutOffset: offset}, false)
		if len(r.truncated) != 0 {
			t.Errorf("%s: truncated %v", stage, r.truncated)
		}
		stdout = append(stdout, r.stdout...)
		offset += uint64(len(r.stdout))
	}

	time.Sleep(3 * time.Second)
	readMore("before restart")
	restartAgent(t)
	readMore("after systemctl restart")
	time.Sleep(2 * time.Second)
	kill9Agent(t)
	readMore("after SIGKILL")
	if st := get(t, c, id).GetState(); st != agentv1.CommandState_COMMAND_STATE_RUNNING {
		t.Fatalf("command state after the restarts = %v, want RUNNING", st)
	}

	// The PTY survived both restarts with its scrollback.
	in.send(t, "echo after-$((20+2))\n")
	out := waitPTY(t, c, ptyID, "after-22")
	if !strings.Contains(out, "before-11") {
		t.Errorf("PTY scrollback lost the output from before the restarts:\n%s", out)
	}

	// Follow to the end from the last offset.
	r := attach(t, c, &agentv1.AttachRequest{CommandId: id, StdoutOffset: offset}, true)
	stdout = append(stdout, r.stdout...)
	if r.exit == nil || r.exit.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED || r.exit.GetCode() != 7 {
		t.Fatalf("exit = %v, want EXITED 7", r.exit)
	}
	var want strings.Builder
	for i := 1; i <= commandSeconds; i++ {
		fmt.Fprintf(&want, "line-%d\n", i)
	}
	if string(stdout) != want.String() {
		t.Errorf("stdout across the restarts (%d bytes) differs from the expected %d bytes", len(stdout), want.Len())
	}
	if r.exit.GetStdoutEnd() != uint64(want.Len()) {
		t.Errorf("stdout_end = %d, want %d", r.exit.GetStdoutEnd(), want.Len())
	}
	in.send(t, "exit\n")
	waitExited(t, c, ptyID, 30*time.Second)
}
