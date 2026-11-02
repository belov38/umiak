package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/agent"
	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/logx"
)

const (
	// logBuffer is the number of log records that may wait for stderr.
	logBuffer = 4096
	// logCloseTimeout bounds the final log flush: stderr may block forever
	// (a frozen journal filesystem), the agent must still exit.
	logCloseTimeout = 2 * time.Second
)

// runOptions are the flags of `umiak-agent run`.
type runOptions struct {
	debugListen  string
	debugConfirm bool
}

// parseRunFlags parses `run [--debug-listen unix:<path> [--debug-confirm]]`;
// ok is false after printing the usage.
func parseRunFlags(args []string, stderr io.Writer) (o runOptions, ok bool) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&o.debugListen, "debug-listen", "", "test aid: also serve the agent API and Control/Info on unix:<path>")
	fs.BoolVar(&o.debugConfirm, "debug-confirm", false, "test aid: Control/Info on the debug socket confirms a pending update without a tunnel")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || (o.debugConfirm && o.debugListen == "") {
		_, _ = io.WriteString(stderr, "usage: umiak-agent run [--debug-listen unix:<path> [--debug-confirm]]\n")
		return o, false
	}
	return o, true
}

// closeLog flushes the async log handler, giving up after logCloseTimeout.
func closeLog(h *logx.Handler) {
	done := make(chan struct{})
	go func() {
		h.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(logCloseTimeout):
	}
}

// doctorCmd implements `umiak-agent doctor [--json]` (spec 17.6).
func doctorCmd(ctx context.Context, d deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print JSON")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		_, _ = io.WriteString(stderr, "usage: umiak-agent doctor [--json]\n")
		return 2
	}
	cfg, err := config.Load(d.layout.ConfigFile)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent doctor: %v; using the default config\n", err)
		cfg = config.Defaults()
	}
	rep := agent.Doctor(ctx, d.layout, cfg, agent.DoctorOptions{
		Source:   d.source,
		IsActive: d.isActive,
		Units:    d.doctorUnits,
		Service:  d.doctorService,
		Statfs:   d.statfs,
		TestAids: d.testAids(),
	})
	if !*asJSON {
		rep.WriteText(stdout)
		return 0
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(rep); err != nil {
		_, _ = fmt.Fprintf(stderr, "umiak-agent doctor: %v\n", err)
		return 1
	}
	return 0
}
