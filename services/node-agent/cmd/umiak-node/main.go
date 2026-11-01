// Command umiak-node runs whitelisted node operations for the sandbox platform.
// In the PoC it is the forced command of a restricted SSH key: one JSON request
// on stdin, one JSON response on stdout.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/syslog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/belov38/umiak/services/node-agent/internal/config"
	"github.com/belov38/umiak/services/node-agent/internal/hostfs"
	"github.com/belov38/umiak/services/node-agent/internal/lvm"
	"github.com/belov38/umiak/services/node-agent/internal/ops"
)

// version is set with -ldflags "-X main.version=...".
var version = "dev"

const maxRequestBytes = 1 << 20

func main() {
	stdio := flag.Bool("stdio", false, "read one JSON request from stdin and write the response to stdout")
	cfgPath := flag.String("config", config.DefaultPath, "config file")
	flag.Parse()
	if !*stdio {
		fmt.Fprintln(os.Stderr, "usage: umiak-node --stdio [--config /etc/umiak-node.toml]")
		os.Exit(2)
	}
	os.Exit(run(*cfgPath))
}

func run(cfgPath string) int {
	enc := json.NewEncoder(os.Stdout)
	fail := func(code, msg string) int {
		_ = enc.Encode(ops.Response{Error: &ops.Error{Code: code, Message: msg}})
		return 1
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fail("exec_failed", "config: "+err.Error())
	}
	logf := func(s string) { fmt.Fprintln(os.Stderr, s) }
	if w, err := syslog.New(syslog.LOG_INFO|syslog.LOG_DAEMON, "umiak-node"); err == nil {
		defer func() { _ = w.Close() }()
		logf = func(s string) { _ = w.Info(s) }
	}
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, maxRequestBytes+1))
	if err != nil {
		return fail("bad_request", err.Error())
	}
	if len(raw) > maxRequestBytes {
		return fail("bad_request", "request too large")
	}
	// The SSH channel closing (SIGHUP, broken stdout) must not kill lvcreate/lvremove half-way:
	// finish the operation and let the caller verify the result.
	signal.Ignore(syscall.SIGHUP, syscall.SIGPIPE)
	ctx := context.Background()
	srv := &ops.Server{
		Cfg:     cfg,
		LVM:     &lvm.Exec{VG: cfg.VG, Run: lvm.RunCommand},
		Host:    ops.Host{FS: os.DirFS("/"), Run: lvm.RunCommand, Now: time.Now, Replace: hostfs.ReplaceLocked},
		Log:     logf,
		Version: version,
	}
	resp := srv.Handle(ctx, raw)
	if err := enc.Encode(resp); err != nil || !resp.OK {
		return 1
	}
	return 0
}
