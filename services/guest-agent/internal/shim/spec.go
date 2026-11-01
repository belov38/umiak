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
	"io"
	"os"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/shimproto"
)

// Stream and marker file names inside the command directory.
const (
	StdoutFile = "stdout"
	StderrFile = "stderr"
	PtyFile    = "pty"
	ShimJSON   = "shim.json"
	ExitJSON   = "exit.json"
	// ShimLog is the log of a Windows shim (its stderr).
	ShimLog = "shim.log"
)

// Lines a Windows shim prints on its stdout once (S9 spec 12.6, plan
// decision 3): ReadyLine when the command runs or its start failure is
// recorded, FailPrefix and the reason when it cannot record anything.
// A reason starting with FailAlreadyStarted means another shim owns the
// command.
const (
	ReadyLine          = "READY"
	FailPrefix         = "FAIL "
	FailAlreadyStarted = "already started"
)

// maxSpecSize bounds a spec read from a stream.
const maxSpecSize = 64 << 20

// ShimFile states.
const (
	StateLaunching = "launching"
	StateRunning   = "running"
)

// DefaultTerm is TERM for a PTY command whose spec names none.
const DefaultTerm = "xterm-256color"

// DefaultKillGrace is the grace between SIGTERM and the cgroup kill when
// Spec.TimeoutMs expires and Spec.KillGraceMs is 0.
const DefaultKillGrace = 10 * time.Second

// Spec is the full command description the agent writes to CmdSpec(id) (mode
// 0600, tmpfs) before starting the unit. The shim reads and deletes it. The
// agent resolves the user, the argv and the environment; the shim does no
// user lookups. On Windows the agent writes it to the shim's stdin instead
// (no tmpfs), and the shim resolves the program and logs the user on.
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
	// KillGraceMs is the grace of the timeout kill; 0 = DefaultKillGrace.
	KillGraceMs uint64 `json:"killGraceMs"`
	// KillLeftovers kills the rest of the payload when the main process exits.
	KillLeftovers bool `json:"killLeftovers"`
	// AgentVersion is the version of the agent that started the shim.
	AgentVersion string `json:"agentVersion"`
	// User is the account the command runs as on Windows: SYSTEM runs it
	// with the shim's own token, another name logs that account on.
	User string `json:"user,omitempty"`
	// Desktop runs the command in the interactive desktop session
	// (Windows); not supported yet.
	Desktop bool `json:"desktop,omitempty"`
	// Script is a wrapped pwsh script too long for -EncodedCommand
	// (Windows). The shim writes it to wincmd.ScriptFile in the command
	// directory, readable by User, before the start (Argv runs it with
	// -File) and deletes it after the exit.
	Script string `json:"script,omitempty"`
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
	s, err := parseSpec(data)
	if err != nil {
		return Spec{}, errors.Join(err, rmErr)
	}
	if rmErr != nil {
		return Spec{}, fmt.Errorf("shim: remove spec: %w", rmErr)
	}
	return s, nil
}

// ReadSpecFrom reads a spec from r to EOF (the shim's stdin on Windows).
// The raw bytes, which hold the environment, are cleared afterwards.
func ReadSpecFrom(r io.Reader) (Spec, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxSpecSize+1))
	defer clear(data)
	if err != nil {
		return Spec{}, fmt.Errorf("shim: read spec: %w", err)
	}
	if len(data) > maxSpecSize {
		return Spec{}, fmt.Errorf("shim: spec is larger than %d bytes", maxSpecSize)
	}
	return parseSpec(data)
}

func parseSpec(data []byte) (Spec, error) {
	var s Spec
	if err := json.Unmarshal(data, &s); err != nil {
		return Spec{}, fmt.Errorf("shim: parse spec: %w", err)
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
