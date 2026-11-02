package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"strings"

	"github.com/belov38/umiak/services/guest-agent/internal/logx"
)

// agentLogName is the agent log in LogDir (Windows).
const agentLogName = "agent.log"

// logsCmd implements `umiak-agent logs [-n N]`: the last N lines of the
// agent log and its rotated files (Windows; Linux uses journalctl).
func logsCmd(d deps, args []string, stdout, stderr io.Writer) int {
	fset := flag.NewFlagSet("logs", flag.ContinueOnError)
	fset.SetOutput(stderr)
	n := fset.Int("n", 500, "number of lines")
	if err := fset.Parse(args); err != nil || fset.NArg() != 0 || *n <= 0 {
		_, _ = io.WriteString(stderr, "usage: umiak-agent logs [-n <lines>]\n")
		return exitUsage
	}
	if d.layout.LogDir == "" {
		_, _ = io.WriteString(stderr, "umiak-agent logs: the agent logs to the journal here: journalctl -u umiak-agent\n")
		return exitUsage
	}
	lines, err := logx.Tail(d.layout.LogDir, agentLogName, *n)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			_, _ = fmt.Fprintf(stderr, "umiak-agent logs: no agent log in %s\n", d.layout.LogDir)
		} else {
			_, _ = fmt.Fprintf(stderr, "umiak-agent logs: %v\n", err)
		}
		return 1
	}
	if len(lines) > 0 {
		_, _ = io.WriteString(stdout, strings.Join(lines, "\n")+"\n")
	}
	return 0
}
