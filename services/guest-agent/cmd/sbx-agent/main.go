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
  run               run the agent daemon
  shim --id <id>    command supervisor (started by the agent)
  identity apply    apply the machine identity (sbx-identity.service)
  quiesce-watchdog  thaw a frozen filesystem when the lease expires
  rollback          roll back an unfinished update
  doctor            print diagnostics
  thaw              thaw the filesystem
  install-package   install an agent package
  seal              prepare a VM for use as a template
  selftest          run built-in checks
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
	case "version":
		_, _ = fmt.Fprintln(stdout, version)
		return 0
	case "identity":
		if len(args) < 2 || args[1] != "apply" {
			_, _ = io.WriteString(stderr, usage)
			return 2
		}
		return identityApply(ctx, d, stderr)
	case "seal":
		return sealCmd(ctx, d, stdout, stderr)
	case "shim":
		// The shim logs to stderr (the unit's journal).
		return shim.Run(args[1:], stderr)
	case "run", "quiesce-watchdog", "rollback", "doctor", "thaw",
		"install-package", "selftest":
		return notImplemented(stderr, args[0])
	default:
		_, _ = fmt.Fprintf(stderr, "sbx-agent: unknown command %q\n\n", args[0])
		_, _ = io.WriteString(stderr, usage)
		return 2
	}
}

func notImplemented(stderr io.Writer, name string) int {
	_, _ = fmt.Fprintf(stderr, "sbx-agent %s: not implemented\n", name)
	return 1
}
