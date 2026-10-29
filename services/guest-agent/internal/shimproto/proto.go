// Package shimproto is the protocol between the agent and a command shim
// (spec section 9.6). Frames on the shim socket are a 4-byte big-endian length
// followed by one JSON object with a "type" field. encoding/json ignores
// unknown fields, so either side may add fields without a version bump; a
// change in meaning bumps Version.
package shimproto

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

// Version is the newest shim protocol version this build speaks. The shim
// accepts [MinVersion, Version]; the agent asks for [MinVersion, Version] too.
const Version = 1

// MinVersion is the oldest shim protocol version this build speaks.
const MinVersion = 1

// MaxFrame is the largest JSON body of one frame.
const MaxFrame = 1 << 20

// ErrFrameTooLarge is returned for a frame whose body exceeds MaxFrame.
var ErrFrameTooLarge = errors.New("shimproto: frame too large")

// Message types.
const (
	// TypeHello opens a connection: the agent sends Min and Max, the shim
	// answers with the chosen Version or an error with CodeShimOutdated.
	TypeHello = "hello"
	// TypeStatus asks for a StatusReply.
	TypeStatus = "status"
	// TypeStatusReply carries Pid, State, LastSeq, Leftovers and Exited.
	TypeStatusReply = "status_reply"
	// TypeInput writes Data to the command (deduplicated by Session and Seq)
	// and, with CloseStdin, closes its stdin afterwards.
	TypeInput = "input"
	// TypeInputReply carries Applied.
	TypeInputReply = "input_reply"
	// TypeResize sets the PTY window size to Cols x Rows.
	TypeResize = "resize"
	// TypeKill sends FirstSignal to the process group and kills the payload
	// cgroup after GraceMs.
	TypeKill = "kill"
	// TypeSignal sends Sig to the process group, or kills the payload cgroup
	// when Cgroup is set.
	TypeSignal = "signal"
	// TypeOK is the reply of a request that has no result.
	TypeOK = "ok"
	// TypeError is the reply of a failed request: Code and Text.
	TypeError = "error"
	// TypeExited is pushed by the shim (ID 0) when the main process has exited
	// and exit.json is on disk.
	TypeExited = "exited"
)

// Process states in a StatusReply.
const (
	StateRunning = "running"
	StateExited  = "exited"
)

// Error codes.
const (
	// CodeShimOutdated: no common protocol version.
	CodeShimOutdated = "shim_outdated"
	// CodeCommandExited: the request needs a running main process.
	CodeCommandExited = "command_exited"
	// CodeFailedPrecondition: the request does not apply to this command
	// (for example close_stdin on a PTY or resize without a PTY).
	CodeFailedPrecondition = "failed_precondition"
	// CodeInvalidArgument: a malformed request.
	CodeInvalidArgument = "invalid_argument"
	// CodeUnknownType: the shim does not know the message type.
	CodeUnknownType = "unknown_type"
	// CodeInternal: an I/O failure inside the shim.
	CodeInternal = "internal"
)

// Exit statuses in ExitFile.Status.
const (
	StatusExited = "exited"
	StatusKilled = "killed"
)

// Exit reasons in ExitFile.Reason (spec section 9.1). Kill.Reason uses
// ReasonSignal, ReasonTimeout or ReasonPTYIdle.
const (
	ReasonNone        = "NONE"
	ReasonSignal      = "SIGNAL"
	ReasonTimeout     = "TIMEOUT"
	ReasonOOM         = "OOM"
	ReasonPTYIdle     = "PTY_IDLE"
	ReasonStartFailed = "START_FAILED"
)

// ExitFile is the content of exit.json in the command directory and the
// payload of an exited push. Its JSON form is stable: an agent of any version
// reads the exit.json of any shim.
type ExitFile struct {
	// Status is StatusExited or StatusKilled (terminated by a signal).
	Status string `json:"status"`
	// Code is the exit code; 128+signal when killed, 127 on START_FAILED.
	Code int32 `json:"code"`
	// Signal is the name of the terminating signal, such as "SIGKILL".
	Signal string `json:"signal,omitempty"`
	// Reason is one of the Reason constants.
	Reason string `json:"reason"`
	// StdoutEnd, StderrEnd and PtyEnd are the file sizes of the streams once
	// all output written before the exit was copied.
	StdoutEnd int64 `json:"stdoutEnd"`
	StderrEnd int64 `json:"stderrEnd"`
	PtyEnd    int64 `json:"ptyEnd"`
	// EndedAt is when the shim saw the exit.
	EndedAt time.Time `json:"endedAt"`
	// StartFailed is the start error text when Reason is ReasonStartFailed.
	StartFailed string `json:"startFailed,omitempty"`
}

// Message is one frame. Only the fields of its Type are set.
type Message struct {
	// Type is one of the Type constants.
	Type string `json:"type"`
	// ID pairs a reply with its request; pushes carry 0.
	ID uint64 `json:"id,omitempty"`

	// Min and Max are the version range of a hello request; Version is the
	// version chosen by the shim in the hello reply.
	Min     int `json:"min,omitempty"`
	Max     int `json:"max,omitempty"`
	Version int `json:"version,omitempty"`

	// Pid, State, LastSeq, Leftovers and Exited form a status reply.
	Pid       int               `json:"pid,omitempty"`
	State     string            `json:"state,omitempty"`
	LastSeq   map[string]uint64 `json:"last_seq,omitempty"`
	Leftovers bool              `json:"leftovers,omitempty"`
	Exited    bool              `json:"exited,omitempty"`

	// Session, Seq, Data and CloseStdin form an input request; Applied is
	// its reply.
	Session    string `json:"session,omitempty"`
	Seq        uint64 `json:"seq,omitempty"`
	Data       []byte `json:"data,omitempty"`
	CloseStdin bool   `json:"close_stdin,omitempty"`
	Applied    bool   `json:"applied,omitempty"`

	// Cols and Rows form a resize request.
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`

	// GraceMs, FirstSignal (0 = SIGTERM) and Reason form a kill request.
	GraceMs     uint32 `json:"grace_ms,omitempty"`
	FirstSignal int    `json:"first_signal,omitempty"`
	Reason      string `json:"reason,omitempty"`

	// Sig and Cgroup form a signal request.
	Sig    int  `json:"sig,omitempty"`
	Cgroup bool `json:"cgroup,omitempty"`

	// Code and Text form an error reply.
	Code string `json:"code,omitempty"`
	Text string `json:"message,omitempty"`

	// Exit is the payload of an exited push.
	Exit *ExitFile `json:"exit,omitempty"`
}

// Error is an error reply from the shim.
type Error struct {
	// Code is one of the Code constants.
	Code string
	// Message is a human-readable description.
	Message string
}

// Error implements error.
func (e *Error) Error() string {
	if e.Message == "" {
		return "shim: " + e.Code
	}
	return "shim: " + e.Code + ": " + e.Message
}

// Write encodes m as one frame. The frame is written with a single Write
// call, so concurrent writers serialized by a mutex never interleave.
func Write(w io.Writer, m Message) error {
	body, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("shimproto: encode %s: %w", m.Type, err)
	}
	if len(body) > MaxFrame {
		return ErrFrameTooLarge
	}
	buf := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(buf, uint32(len(body))) //nolint:gosec // bounded by MaxFrame
	copy(buf[4:], body)
	_, err = w.Write(buf)
	return err
}

// Read decodes one frame. It returns io.EOF only when r ends cleanly before
// a frame.
func Read(r io.Reader) (Message, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return Message{}, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > MaxFrame {
		return Message{}, ErrFrameTooLarge
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return Message{}, err
	}
	var m Message
	if err := json.Unmarshal(body, &m); err != nil {
		return Message{}, fmt.Errorf("shimproto: decode frame: %w", err)
	}
	if m.Type == "" {
		return Message{}, errors.New("shimproto: frame without type")
	}
	return m, nil
}

// Negotiate picks the highest version both ranges contain.
func Negotiate(clientMin, clientMax, serverMin, serverMax int) (int, bool) {
	v := min(clientMax, serverMax)
	if v < clientMin || v < serverMin {
		return 0, false
	}
	return v, true
}

// Accept performs the shim side of the hello exchange on a new connection:
// it reads the hello, answers with the chosen version or a shim_outdated
// error, and returns the chosen version.
func Accept(rw io.ReadWriter, serverMin, serverMax int) (int, error) {
	m, err := Read(rw)
	if err != nil {
		return 0, err
	}
	if m.Type != TypeHello {
		perr := &Error{Code: CodeInvalidArgument, Message: "expected hello, got " + m.Type}
		_ = Write(rw, Message{Type: TypeError, ID: m.ID, Code: perr.Code, Text: perr.Message})
		return 0, perr
	}
	v, ok := Negotiate(m.Min, m.Max, serverMin, serverMax)
	if !ok {
		perr := &Error{Code: CodeShimOutdated,
			Message: fmt.Sprintf("shim speaks %d..%d, agent %d..%d", serverMin, serverMax, m.Min, m.Max)}
		_ = Write(rw, Message{Type: TypeError, ID: m.ID, Code: perr.Code, Text: perr.Message})
		return 0, perr
	}
	if err := Write(rw, Message{Type: TypeHello, ID: m.ID, Version: v}); err != nil {
		return 0, err
	}
	return v, nil
}
