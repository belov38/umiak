package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"syscall"

	"github.com/google/uuid"
)

// agentURL is the base URL of requests on a local socket; the host is not
// used for routing.
const agentURL = "http://sbx-agent"

// Exit codes of the local clients (call, exec, selftest --pty, env).
const (
	exitUsage = 2
	// exitAgent is the exit code of exec when the agent failed it, so it
	// does not pass for an exit code of the command.
	exitAgent = 125
	// exitNotStarted is the exit code of exec when the command did not
	// start (not found, bad user).
	exitNotStarted = 127
)

// socketClient returns an HTTP client that dials the unix socket path. It
// has no timeout: exec streams for as long as the command runs.
func socketClient(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
	}}
}

// adminSocket returns the admin socket of d, or prints that this OS has
// none and returns "".
func adminSocket(d deps, cmd string, stderr io.Writer) string {
	if d.layout.AdminSocket == "" {
		_, _ = fmt.Fprintf(stderr, "sbx-agent %s: no admin socket on this OS (Windows only)\n", cmd)
	}
	return d.layout.AdminSocket
}

// unreachable reports an error of dialing a socket nobody listens on (the
// agent is not running or has not opened it yet).
func unreachable(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial" ||
		errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
}

// newCommandID returns the id of a command started by the CLI.
func newCommandID() string {
	return "cli-" + uuid.NewString()
}
