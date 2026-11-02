package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/proto/umiak/agent/v1/agentv1connect"
	"github.com/belov38/umiak/libs/tunnel/wire"

	"github.com/belov38/umiak/services/guest-agent/internal/quiesce"
)

// thawTimeout bounds System/Thaw of `thaw --force`.
const thawTimeout = 30 * time.Second

// quiesceWatchdog implements `umiak-agent quiesce-watchdog --lease <id>`, the
// command of the transient unit umiak-quiesce-watchdog-<id>.service. It logs
// to stderr (the unit's journal).
func quiesceWatchdog(d deps, args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("quiesce-watchdog", flag.ContinueOnError)
	fs.SetOutput(stderr)
	lease := fs.String("lease", "", "lease id")
	if err := fs.Parse(args); err != nil || *lease == "" || fs.NArg() != 0 {
		_, _ = io.WriteString(stderr, "usage: umiak-agent quiesce-watchdog --lease <id>\n")
		return 2
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(stderr, nil)))
	return quiesce.Watchdog(d.layout, *lease, d.freezer, d.docker)
}

// thawCmd implements `umiak-agent thaw --force`, the emergency thaw for the
// QEMU guest agent (spec 17.6). It works without a running agent. With an
// admin socket (Windows) it ends the lease through the agent instead
// (thawThroughAgent).
func thawCmd(ctx context.Context, d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("thaw", flag.ContinueOnError)
	fs.SetOutput(stderr)
	force := fs.Bool("force", false, "thaw every filesystem and unpause every paused container")
	if err := fs.Parse(args); err != nil || !*force || fs.NArg() != 0 {
		_, _ = io.WriteString(stderr, "usage: umiak-agent thaw --force\n")
		return 2
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(stderr, nil)))
	if d.layout.AdminSocket != "" {
		return thawThroughAgent(ctx, d, stdout, stderr)
	}
	if err := quiesce.ForceThaw(d.layout, d.freezer, d.docker); err != nil { //nolint:contextcheck // an emergency thaw runs to completion
		_, _ = fmt.Fprintf(stderr, "umiak-agent thaw: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "thawed")
	return 0
}

// thawThroughAgent is `thaw --force` on Windows (S9 spec 12.10): VSS thaws
// the filesystem itself, so what is left is the lease and the secret files
// it wiped, whose contents only the running agent holds. System/Thaw of the
// recorded lease on the admin socket restores them and ends the lease. When
// the agent is not running the lease file is dropped; the secret files then
// come back with the next UpdateSecrets.
func thawThroughAgent(ctx context.Context, d deps, stdout, stderr io.Writer) int {
	lease, err := quiesce.LeaseOnDisk(d.layout)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent thaw: %v; dropping it\n", err)
	}
	if lease == nil {
		if err != nil {
			if derr := quiesce.DropLease(d.layout); derr != nil {
				_, _ = fmt.Fprintf(stderr, "umiak-agent thaw: %v\n", derr)
				return 1
			}
		}
		_, _ = fmt.Fprintln(stdout, "no quiesce lease")
		return 0
	}
	ctx, cancel := context.WithTimeout(ctx, thawTimeout)
	defer cancel()
	sys := agentv1connect.NewSystemClient(socketClient(d.layout.AdminSocket), agentURL)
	req := connect.NewRequest(&agentv1.ThawRequest{LeaseId: lease.ID})
	req.Header().Set(wire.HeaderRequestID, uuid.NewString())
	_, err = sys.Thaw(ctx, req)
	switch {
	case err == nil:
		// A lease the agent no longer knows (already_thawed) may leave a
		// stale file behind.
		if left, _ := quiesce.LeaseOnDisk(d.layout); left != nil && left.ID == lease.ID {
			if err := quiesce.DropLease(d.layout); err != nil {
				_, _ = fmt.Fprintf(stderr, "umiak-agent thaw: %v\n", err)
			}
		}
		_, _ = fmt.Fprintf(stdout, "thawed lease %s; the agent restored the secret files\n", lease.ID)
		return 0
	case !unreachable(err):
		_, _ = fmt.Fprintf(stderr, "umiak-agent thaw: System/Thaw of lease %s: %v\n", lease.ID, err)
		return 1
	}
	if err := quiesce.DropLease(d.layout); err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent thaw: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "thawed: the agent is not running, lease %s dropped; wiped secret files come back with UpdateSecrets\n", lease.ID)
	return 0
}
