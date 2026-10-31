package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1/agentv1connect"
	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

const execUsage = "usage: sbx-agent exec [--user <u>] [--pty] [--cwd <dir>] [-i] (--shell <script> | -- <argv>...)\n"

// PTY size of exec --pty and selftest --pty.
const (
	ptyCols = 120
	ptyRows = 40
)

// cleanupTimeout bounds the Kill and Remove calls exec makes on its way out.
const cleanupTimeout = 5 * time.Second

// execCmd implements `sbx-agent exec`: Process/Run over the admin socket
// (the same token and shim path as the API), the output streamed to stdout
// and stderr (a PTY to stdout), and the exit code of the command as its
// own. A killed command exits 137 (Windows: 1, the code of a terminated
// job), a command that did not start 127, a failure of the agent or the
// connection 125. -i forwards stdin; --pty implies it. Ctrl+C kills the
// command. The command record is removed afterwards.
func execCmd(ctx context.Context, d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("exec", flag.ContinueOnError)
	fs.SetOutput(stderr)
	usr := fs.String("user", "", "run as this user (default: the agent's default user)")
	pty := fs.Bool("pty", false, "allocate a terminal (implies -i)")
	cwd := fs.String("cwd", "", "working directory")
	shell := fs.String("shell", "", "script for the user's shell instead of argv")
	stdin := fs.Bool("i", false, "forward stdin to the command")
	if err := fs.Parse(args); err != nil || (*shell == "") == (fs.NArg() == 0) {
		_, _ = io.WriteString(stderr, execUsage)
		return exitUsage
	}
	sock := adminSocket(d, "exec", stderr)
	if sock == "" {
		return exitUsage
	}
	spec := &agentv1.CommandSpec{User: *usr, Cwd: *cwd, Stdin: *stdin || *pty}
	if *shell != "" {
		spec.Cmd = &agentv1.CommandSpec_Shell{Shell: *shell}
	} else {
		spec.Cmd = &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: fs.Args()}}
	}
	if *pty {
		spec.Pty = &agentv1.Pty{Cols: ptyCols, Rows: ptyRows}
	}
	var input io.Reader
	if spec.Stdin {
		input = d.stdin
	}

	noteSecretsPending(ctx, sock, stderr)
	c := d.commandRun(sock, stdout, stderr)
	sigCtx, stop := signal.NotifyContext(context.WithoutCancel(ctx), os.Interrupt)
	defer stop()
	finished := make(chan struct{})
	go func() {
		select {
		case <-sigCtx.Done():
			c.kill(ctx)
		case <-finished:
		}
	}()
	exit, err := c.run(ctx, spec, input)
	close(finished)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent exec: %v\n", err)
		// The API reports an unknown account as validation (S7), before
		// an ExitEvent exists. For exec it still means "did not start".
		if detail, ok := rpcconv.Detail(err); ok && detail.GetCode() == errs.UserNotFound {
			return exitNotStarted
		}
		return exitAgent
	}
	c.remove(ctx)
	return exitCode(exit, runtime.GOOS, stderr)
}

// exitCode maps the exit of a command to the exit code of exec.
func exitCode(e *agentv1.ExitEvent, goos string, stderr io.Writer) int {
	switch {
	case e.GetReason() == agentv1.ExitReason_EXIT_REASON_START_FAILED:
		_, _ = io.WriteString(stderr, "sbx-agent exec: the command did not start\n")
		return exitNotStarted
	case e.GetStatus() == agentv1.ExitStatus_EXIT_STATUS_EXITED:
		// Windows passes NTSTATUS codes through: os.Exit hands the int
		// to ExitProcess as a uint32.
		return int(e.GetCode())
	case e.GetStatus() == agentv1.ExitStatus_EXIT_STATUS_KILLED:
		if goos == "windows" {
			return 1
		}
		if e.GetCode() > 128 {
			return int(e.GetCode())
		}
		return 128 + 9
	default:
		_, _ = fmt.Fprintf(stderr, "sbx-agent exec: the command ended with status %s (%s)\n", e.GetStatus(), e.GetReason())
		return exitAgent
	}
}

// commandRun is one command the CLI runs over the admin socket.
type commandRun struct {
	proc           agentv1connect.ProcessClient
	id             string
	stdout, stderr io.Writer
}

// commandRun returns a commandRun with a new command id.
func (d deps) commandRun(sock string, stdout, stderr io.Writer) *commandRun {
	newID := d.newID
	if newID == nil {
		newID = newCommandID
	}
	return &commandRun{
		proc:   agentv1connect.NewProcessClient(socketClient(sock), agentURL),
		id:     newID(),
		stdout: stdout,
		stderr: stderr,
	}
}

// run starts the command with Process/Run and streams its output until
// the exit event. input, if set, is forwarded once the command started.
func (c *commandRun) run(ctx context.Context, spec *agentv1.CommandSpec, input io.Reader) (*agentv1.ExitEvent, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := c.proc.Run(ctx, connect.NewRequest(&agentv1.RunRequest{CommandId: c.id, Spec: spec}))
	if err != nil {
		return nil, err
	}
	defer func() { _ = stream.Close() }()
	var exit *agentv1.ExitEvent
	for exit == nil && stream.Receive() {
		switch ev := stream.Msg().GetEvent().(type) {
		case *agentv1.AttachResponse_Started:
			if input != nil {
				go c.forward(ctx, input, spec.GetPty() != nil)
			}
		case *agentv1.AttachResponse_Data:
			w := c.stdout
			if ev.Data.GetStream() == agentv1.Stream_STREAM_STDERR {
				w = c.stderr
			}
			_, _ = w.Write(ev.Data.GetData())
		case *agentv1.AttachResponse_Truncated:
			_, _ = fmt.Fprintf(c.stderr, "sbx-agent exec: output of %s dropped before offset %d\n",
				ev.Truncated.GetStream(), ev.Truncated.GetAvailableFrom())
		case *agentv1.AttachResponse_Exit:
			exit = ev.Exit
		}
	}
	if exit != nil {
		return exit, nil
	}
	if err := stream.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("the output stream ended without an exit")
}

// forward sends r to the command's stdin until EOF; then it closes stdin
// (a PTY has no stdin to close: the input just stops).
func (c *commandRun) forward(ctx context.Context, r io.Reader, pty bool) {
	session := "cli-" + uuid.NewString()
	var seq uint64
	send := func(data []byte, closeStdin bool) error {
		seq++
		_, err := c.proc.SendInput(ctx, connect.NewRequest(&agentv1.SendInputRequest{
			CommandId: c.id, InputSessionId: session, Seq: seq, Data: data, CloseStdin: closeStdin,
		}))
		return err
	}
	buf := make([]byte, 32<<10)
	for {
		n, rerr := r.Read(buf)
		if n > 0 {
			if err := send(bytes.Clone(buf[:n]), false); err != nil {
				if ctx.Err() == nil {
					_, _ = fmt.Fprintf(c.stderr, "sbx-agent exec: input: %v\n", err)
				}
				return
			}
		}
		if rerr != nil {
			if !pty {
				_ = send(nil, true)
			}
			return
		}
	}
}

// kill kills the command (Ctrl+C of exec), also after ctx ended.
func (c *commandRun) kill(ctx context.Context) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()
	if _, err := c.proc.Kill(ctx, connect.NewRequest(&agentv1.KillRequest{CommandId: c.id})); err != nil {
		_, _ = fmt.Fprintf(c.stderr, "sbx-agent exec: kill: %v\n", err)
	}
}

// remove forgets the exited command, also after ctx ended; a failure only
// leaves it to the retention of the agent.
func (c *commandRun) remove(ctx context.Context) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()
	_, _ = c.proc.Remove(ctx, connect.NewRequest(&agentv1.ProcessRemoveRequest{CommandId: c.id}))
}

// selftestPTYTimeout bounds `selftest --pty`.
const selftestPTYTimeout = 90 * time.Second

// ptyProbeArgv reads one line on the terminal and prints it: Read-Host of
// pwsh in a ConPTY on Windows, read in sh elsewhere.
func ptyProbeArgv(goos string) []string {
	if goos == "windows" {
		return []string{"pwsh.exe", "-NoLogo", "-NoProfile", "-Command", "Read-Host"}
	}
	return []string{"sh", "-c", `read l; echo "$l"`}
}

// selftestPTY implements `sbx-agent selftest --pty`: a PTY command of the
// default user over the admin socket reads a line typed into its terminal;
// the line must come back in the terminal output and the command must exit
// 0.
func selftestPTY(ctx context.Context, d deps, stdout, stderr io.Writer) int {
	sock := adminSocket(d, "selftest --pty", stderr)
	if sock == "" {
		return exitUsage
	}
	ctx, cancel := context.WithTimeout(ctx, selftestPTYTimeout)
	defer cancel()
	token := "sbx-selftest-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var out bytes.Buffer
	c := d.commandRun(sock, &out, &out)
	spec := &agentv1.CommandSpec{
		Cmd:       &agentv1.CommandSpec_Argv{Argv: &agentv1.Argv{Args: ptyProbeArgv(runtime.GOOS)}},
		Pty:       &agentv1.Pty{Cols: ptyCols, Rows: ptyRows},
		Stdin:     true,
		TimeoutMs: uint64(selftestPTYTimeout.Milliseconds()),
	}
	exit, err := c.run(ctx, spec, strings.NewReader(token+"\r"))
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent selftest --pty: %v\n", err)
		if ctx.Err() != nil {
			c.kill(ctx)
		}
		return 1
	}
	c.remove(ctx)
	if exit.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_EXITED || exit.GetCode() != 0 || !strings.Contains(out.String(), token) {
		_, _ = fmt.Fprintf(stderr, "sbx-agent selftest --pty: status %s code %d, terminal output %q (want %q)\n",
			exit.GetStatus(), exit.GetCode(), lastBytes(out.Bytes(), 512), token)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "ok")
	return 0
}

// lastBytes returns at most the last n bytes of b.
func lastBytes(b []byte, n int) []byte {
	if len(b) > n {
		return b[len(b)-n:]
	}
	return b
}

// noteSecretsPending prints a note when the secrets phase is pending: the
// admin socket does not wait for UpdateSecrets, so the command runs without
// the secret env and the secret files. A failing System/Info is ignored;
// the command itself reports what is wrong.
func noteSecretsPending(ctx context.Context, sock string, stderr io.Writer) {
	ctx, cancel := context.WithTimeout(ctx, cleanupTimeout)
	defer cancel()
	res, err := agentv1connect.NewSystemClient(socketClient(sock), agentURL).Info(ctx, connect.NewRequest(&agentv1.InfoRequest{}))
	if err != nil {
		return
	}
	for _, p := range res.Msg.GetReadiness() {
		if p.GetName() == "secrets" && p.GetState() == agentv1.PhaseState_PHASE_STATE_PENDING {
			_, _ = io.WriteString(stderr, "sbx-agent exec: note: the secrets are pending (not sent again since the agent restarted or PrepareStop); the command runs without them\n")
			return
		}
	}
}
