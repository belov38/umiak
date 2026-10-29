// Package shim is the command supervisor (spec sections 9.2-9.6). The agent
// starts one shim per command as a transient systemd unit; the shim runs the
// command inside the unit's payload cgroup, copies its output into append-only
// log files, records exit.json and serves a unix socket for the agent. Its
// state lives outside the agent, so a command survives an agent restart.
package shim

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
)

// Stream and marker file names inside the command directory.
const (
	StdoutFile = "stdout"
	StderrFile = "stderr"
	PtyFile    = "pty"
	ShimJSON   = "shim.json"
	ExitJSON   = "exit.json"
)

// ShimFile states.
const (
	StateLaunching = "launching"
	StateRunning   = "running"
)

// DefaultTerm is TERM for a PTY command whose spec names none.
const DefaultTerm = "xterm-256color"

// TimeoutGrace is the grace between SIGTERM and the cgroup kill when
// Spec.TimeoutMs expires.
const TimeoutGrace = 10 * time.Second

// Spec is the full command description the agent writes to CmdSpec(id) (mode
// 0600, tmpfs) before starting the unit. The shim reads and deletes it. The
// agent resolves the user, the argv and the environment; the shim does no
// user lookups.
type Spec struct {
	// ID is the command id; it must match --id.
	ID string `json:"id"`
	// Argv is the program and its arguments. A program without a slash is
	// looked up in the PATH of Env.
	Argv []string `json:"argv"`
	// Env is the complete environment of the process.
	Env []string `json:"env"`
	// Cwd is the working directory; empty keeps the shim's.
	Cwd string `json:"cwd"`
	// UID, GID and Groups are the credentials of the process.
	UID    uint32   `json:"uid"`
	GID    uint32   `json:"gid"`
	Groups []uint32 `json:"groups"`
	// PTY, when set, runs the command on a terminal with a single pty stream.
	PTY *PTYSpec `json:"pty,omitempty"`
	// Stdin opens a stdin pipe; otherwise stdin is /dev/null. A PTY command
	// always reads the terminal and ignores Stdin.
	Stdin bool `json:"stdin"`
	// TimeoutMs kills the command (reason TIMEOUT) after this long; 0 = none.
	TimeoutMs uint64 `json:"timeoutMs"`
	// KillLeftovers kills the rest of the payload when the main process exits.
	KillLeftovers bool `json:"killLeftovers"`
	// AgentVersion is the version of the agent that started the shim.
	AgentVersion string `json:"agentVersion"`
}

// PTYSpec is the terminal of a PTY command.
type PTYSpec struct {
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
	// Term is TERM for the process; empty means DefaultTerm. It is added to
	// the environment only when Env has no TERM.
	Term string `json:"term"`
}

// ShimFile is shim.json in the command directory. The shim writes it with
// State launching before the process starts and rewrites it with State
// running, Pid and StartedAt afterwards (spec section 9.2).
type ShimFile struct { //nolint:revive // name fixed by the plan; the agent reads it as shim.ShimFile
	State        string    `json:"state"`
	AgentVersion string    `json:"agentVersion"`
	ShimProto    int       `json:"shimProto"`
	Pid          int       `json:"pid,omitempty"`
	StartedAt    time.Time `json:"startedAt,omitzero"`
}

// ExitFile is exit.json in the command directory.
type ExitFile = shimproto.ExitFile

// ReadSpec reads the spec file at path and deletes it: the spec holds the
// environment, which must not outlive the start.
func ReadSpec(path string) (Spec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Spec{}, err
	}
	rmErr := os.Remove(path)
	var s Spec
	if err := json.Unmarshal(data, &s); err != nil {
		return Spec{}, errors.Join(fmt.Errorf("shim: parse spec: %w", err), rmErr)
	}
	if rmErr != nil {
		return Spec{}, fmt.Errorf("shim: remove spec: %w", rmErr)
	}
	return s, nil
}

// validate checks the parts of s the shim relies on.
func (s Spec) validate(id string) error {
	if s.ID != id {
		return fmt.Errorf("shim: spec id %q does not match --id %q", s.ID, id)
	}
	if len(s.Argv) == 0 || s.Argv[0] == "" {
		return errors.New("shim: empty argv")
	}
	return nil
}
