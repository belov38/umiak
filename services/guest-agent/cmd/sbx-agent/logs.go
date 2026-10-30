package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"strings"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/logx"
)

// agentLogName is the agent log in LogDir (Windows).
const agentLogName = "agent.log"

// logsCmd implements `sbx-agent logs [-n N]`: the last N lines of the
// agent log and its rotated files (Windows; Linux uses journalctl).
func logsCmd(d deps, args []string, stdout, stderr io.Writer) int {
	fset := flag.NewFlagSet("logs", flag.ContinueOnError)
	fset.SetOutput(stderr)
	n := fset.Int("n", 500, "number of lines")
	if err := fset.Parse(args); err != nil || fset.NArg() != 0 || *n <= 0 {
		_, _ = io.WriteString(stderr, "usage: sbx-agent logs [-n <lines>]\n")
		return exitUsage
	}
	if d.layout.LogDir == "" {
		_, _ = io.WriteString(stderr, "sbx-agent logs: the agent logs to the journal here: journalctl -u sbx-agent\n")
		return exitUsage
	}
	lines, err := logx.Tail(d.layout.LogDir, agentLogName, *n)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			_, _ = fmt.Fprintf(stderr, "sbx-agent logs: no agent log in %s\n", d.layout.LogDir)
		} else {
			_, _ = fmt.Fprintf(stderr, "sbx-agent logs: %v\n", err)
		}
		return 1
	}
	if len(lines) > 0 {
		_, _ = io.WriteString(stdout, strings.Join(lines, "\n")+"\n")
	}
	return 0
}
