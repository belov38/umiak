// Command umiak-node runs whitelisted node operations for the sandbox platform.
// In the PoC it is the forced command of a restricted SSH key: one JSON request
// on stdin, one JSON response on stdout.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	receive := flag.String("receive-volume", "", "internal cluster volume import")
	stdio := flag.Bool("stdio", false, "read one JSON request from stdin and write the response to stdout")
	cfgPath := flag.String("config", config.DefaultPath, "config file")
	flag.Parse()
	if *receive != "" {
		os.Exit(receiveVolume(*cfgPath, *receive))
	}
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
	reader := bufio.NewReaderSize(os.Stdin, 64<<10)
	line, err := readRequestLine(reader, maxRequestBytes)
	if err != nil {
		return fail("bad_request", err.Error())
	}
	var initial ops.Request
	_ = json.Unmarshal(line, &initial)
	var raw []byte
	if initial.Op == "lv.deltaStream" {
		raw = line
	} else {
		rest, e := io.ReadAll(io.LimitReader(reader, maxRequestBytes+1))
		if e != nil {
			return fail("bad_request", e.Error())
		}
		raw = append(line, rest...)
		if len(raw) > maxRequestBytes {
			return fail("bad_request", "request too large")
		}
	}
	// The SSH channel closing (SIGHUP, broken stdout) must not kill lvcreate/lvremove half-way:
	// finish the operation and let the caller verify the result.
	signal.Ignore(syscall.SIGHUP, syscall.SIGPIPE)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv := &ops.Server{
		Cfg:     cfg,
		LVM:     &lvm.Exec{VG: cfg.VG, Run: lvm.RunCommand},
		Host:    ops.Host{FS: os.DirFS("/"), Run: lvm.RunCommand, Now: time.Now, Replace: hostfs.ReplaceLocked},
		Log:     logf,
		Version: version,
	}
	if initial.Op == "lv.deltaStream" {
		if err := srv.DeltaStream(ctx, initial.Args, reader, os.Stdout); err != nil {
			return fail("delta_failed", err.Error())
		}
		return 0
	}
	srv.Progress = func(p map[string]any) error {
		err := enc.Encode(map[string]any{"event": "progress", "progress": p})
		if err != nil {
			cancel()
		}
		return err
	}
	resp := srv.Handle(ctx, raw)
	if err := enc.Encode(resp); err != nil || !resp.OK {
		return 1
	}
	return 0
}

func receiveVolume(cfgPath, encoded string) int {
	enc := json.NewEncoder(os.Stdout)
	fail := func(err error) int {
		_ = enc.Encode(ops.Response{Error: &ops.Error{Code: "import_failed", Message: err.Error()}})
		return 1
	}
	if len(encoded) > 8192 {
		return fail(fmt.Errorf("import metadata too large"))
	}
	raw, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return fail(err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fail(err)
	}
	srv := &ops.Server{Cfg: cfg, LVM: &lvm.Exec{VG: cfg.VG, Run: lvm.RunCommand}, Host: ops.Host{FS: os.DirFS("/"), Run: lvm.RunCommand, Now: time.Now, Replace: hostfs.ReplaceLocked}, Log: func(s string) { fmt.Fprintln(os.Stderr, s) }}
	result, err := srv.ReceiveVolume(context.Background(), raw, os.Stdin)
	if err != nil {
		return fail(err)
	}
	if err = enc.Encode(ops.Response{OK: true, Result: result}); err != nil {
		return 1
	}
	return 0
}

func readRequestLine(r *bufio.Reader, limit int) ([]byte, error) {
	var b bytes.Buffer
	for {
		part, err := r.ReadSlice('\n')
		if b.Len()+len(part) > limit {
			return nil, fmt.Errorf("request too large")
		}
		_, _ = b.Write(part)
		if err == nil || err == io.EOF {
			return b.Bytes(), nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}
