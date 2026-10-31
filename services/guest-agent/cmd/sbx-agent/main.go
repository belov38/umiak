// Command sbx-agent is the guest agent of a sandbox VM and its CLI.
package main

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shim"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `usage: sbx-agent <command>

commands:
  run [--debug-listen unix:<path> [--debug-confirm]]
                    run the agent daemon (the debug flags are a test aid)
  shim --id <id>    command supervisor (started by the agent)
  identity apply [--specialize]
                    apply the machine identity (sbx-identity.service;
                    --specialize: the Windows sysprep specialize pass)
  early             Windows boot step (computer startup script)
  quiesce-watchdog --lease <id>
                    thaw a quiesce lease when it expires (started by the agent)
  rollback [--to <version>]
                    roll back an unfinished update, or switch to a version
  doctor [--json]   print diagnostics
  thaw --force      thaw every filesystem and unpause every paused container
                    (Windows: end the quiesce lease through the agent)
  exec [--user <u>] [--pty] [--cwd <dir>] [-i] (--shell <script> | -- <argv>...)
                    run a command through the agent (Windows admin socket)
  call <package.Service/Method> [<json>|-]
                    one unary agent API call, JSON in and out (admin socket)
  env [--format pwsh|cmd|sh]
                    the sandbox env for a session shell (Windows)
  logs [-n <lines>] the last lines of the agent log (Windows)
  install-package [--no-activate] [--no-units] [--write-config] <tar>
                    install a signed agent package
  seal              prepare a VM for use as a template
  selftest --schema <n> [--shim-protos 1,2]
                    check that this version can take over the machine
  selftest --pty    check a terminal session through the running agent
  version           print the version
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run dispatches a subcommand and returns the process exit code.
func run(args []string, stdout, stderr io.Writer) int {
	return runWith(context.Background(), defaultDeps(), args, stdout, stderr)
}

// runWith is run with explicit dependencies.
func runWith(ctx context.Context, d deps, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = io.WriteString(stderr, usage)
		return 2
	}
	switch args[0] {
	case "session":
		return sessionCmd(ctx, args[1:], stderr)
	case "version":
		_, _ = fmt.Fprintln(stdout, d.version)
		return 0
	case "identity":
		if len(args) < 2 || args[1] != "apply" {
			_, _ = io.WriteString(stderr, usage)
			return 2
		}
		return identityApply(ctx, d, args[2:], stderr)
	case "early":
		return earlyCmd(ctx, d, args[1:], stderr)
	case "seal":
		return sealCmd(ctx, d, stdout, stderr)
	case "shim":
		// The shim logs to stderr (the unit's journal; shim.log on Windows).
		return shim.Run(args[1:], stderr)
	case "quiesce-watchdog":
		return quiesceWatchdog(d, args[1:], stderr) //nolint:contextcheck // the watchdog runs to completion on its own clock
	case "thaw":
		return thawCmd(ctx, d, args[1:], stdout, stderr)
	case "install-package":
		return installPackage(d, args[1:], stdout, stderr)
	case "rollback":
		return rollbackCmd(d, args[1:], stderr)
	case "selftest":
		return selftestCmd(ctx, d, args[1:], stdout, stderr)
	case "exec":
		return execCmd(ctx, d, args[1:], stdout, stderr)
	case "call":
		return callCmd(ctx, d, args[1:], stdout, stderr)
	case "env":
		return envCmd(ctx, d, args[1:], stdout, stderr)
	case "logs":
		return logsCmd(d, args[1:], stdout, stderr)
	case "run":
		return runAgent(ctx, d, args[1:], stderr)
	case "doctor":
		return doctorCmd(ctx, d, args[1:], stdout, stderr)
	default:
		_, _ = fmt.Fprintf(stderr, "sbx-agent: unknown command %q\n\n", args[0])
		_, _ = io.WriteString(stderr, usage)
		return 2
	}
}
