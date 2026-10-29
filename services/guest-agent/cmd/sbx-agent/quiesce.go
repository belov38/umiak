package main

import (
	"flag"
	"fmt"
	"io"
	"log/slog"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/quiesce"
)

// quiesceWatchdog implements `sbx-agent quiesce-watchdog --lease <id>`, the
// command of the transient unit sbx-quiesce-watchdog-<id>.service. It logs
// to stderr (the unit's journal).
func quiesceWatchdog(d deps, args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("quiesce-watchdog", flag.ContinueOnError)
	fs.SetOutput(stderr)
	lease := fs.String("lease", "", "lease id")
	if err := fs.Parse(args); err != nil || *lease == "" || fs.NArg() != 0 {
		_, _ = io.WriteString(stderr, "usage: sbx-agent quiesce-watchdog --lease <id>\n")
		return 2
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(stderr, nil)))
	return quiesce.Watchdog(d.layout, *lease, d.freezer, d.docker)
}

// thawCmd implements `sbx-agent thaw --force`, the emergency thaw for the
// QEMU guest agent (spec 17.6). It works without a running agent.
func thawCmd(d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("thaw", flag.ContinueOnError)
	fs.SetOutput(stderr)
	force := fs.Bool("force", false, "thaw every filesystem and unpause every paused container")
	if err := fs.Parse(args); err != nil || !*force || fs.NArg() != 0 {
		_, _ = io.WriteString(stderr, "usage: sbx-agent thaw --force\n")
		return 2
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(stderr, nil)))
	if err := quiesce.ForceThaw(d.layout, d.freezer, d.docker); err != nil {
		_, _ = fmt.Fprintf(stderr, "sbx-agent thaw: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "thawed")
	return 0
}
