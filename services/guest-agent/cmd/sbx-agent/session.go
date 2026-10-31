package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/desktop"
)

func sessionCmd(ctx context.Context, args []string, stderr io.Writer) int {
	if len(args) != 2 || args[0] != "--socket" {
		_, _ = fmt.Fprintln(stderr, "usage: sbx-agent session --socket <path>")
		return 2
	}
	ctx, cancel := signal.NotifyContext(ctx, os.Interrupt)
	defer cancel()
	if e := desktop.RunHelper(ctx, args[1]); e != nil {
		_, _ = fmt.Fprintln(stderr, "desktop helper:", e)
		return 1
	}
	return 0
}
