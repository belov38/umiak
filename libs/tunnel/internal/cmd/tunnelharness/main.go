// Command tunnelharness runs gateways and agents of the tunnel library in one
// process for the TS agent-client e2e tests (packages/agent-client). It is
// test infrastructure, not a product binary.
//
// Gateways serve real internal listeners on 127.0.0.1 (h2c and HTTP/1.1);
// agents reach them over an in-memory network (memnet) and serve the Process
// test double. Timings are shrunk as in internal/e2e.
//
// Flags: -db <dsn> (an existing, empty database; the tunnel migrations are
// applied to it), -token <service token>, -gateways N, -agents N.
//
// Once ready it prints one JSON line to stdout:
//
//	{"machines":["<uuid>"],"gateways":[{"id":"gw-1","url":"http://127.0.0.1:<port>"}],"control":"http://127.0.0.1:<port>"}
//
// Logs go to stderr. Control endpoints:
//
//	POST /fault {"kind":"cut"|"stall"|"drain"|"kill-gateway"|"restart-agent","machine":"<uuid>"}
//	     200 once injected; 409 while a fault of the same kind is in
//	     progress or when the machine has no live link.
//	GET  /starts?command=<id>  {"starts":N}
//	GET  /labels?command=<id>  {"calls":N}
//
// It stops everything and exits 0 on stdin EOF, SIGINT or SIGTERM.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	os.Exit(run())
}

func run() int {
	var cfg config
	flag.StringVar(&cfg.dsn, "db", "", "Postgres connection string of an empty database (required)")
	flag.StringVar(&cfg.token, "token", "", "service token of the internal listeners (required)")
	flag.IntVar(&cfg.gateways, "gateways", 2, "number of gateways")
	flag.IntVar(&cfg.agents, "agents", 1, "number of machines, one agent each")
	flag.Parse()

	level := slog.LevelInfo
	if os.Getenv("SBX_TEST_LOG") != "" {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	if cfg.dsn == "" || cfg.token == "" || cfg.gateways < 1 || cfg.agents < 1 {
		log.Error("tunnelharness: -db and -token are required, -gateways and -agents must be at least 1")
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		// The parent closes stdin to stop the harness.
		_, _ = io.Copy(io.Discard, os.Stdin)
		log.Info("tunnelharness: stdin closed")
		stop()
	}()

	h, err := newHarness(ctx, cfg, log)
	if err != nil {
		log.Error("tunnelharness: start", "err", err)
		if h != nil {
			h.close()
		}
		return 1
	}
	ctl, err := serveControl(h)
	if err != nil {
		log.Error("tunnelharness: control listener", "err", err)
		h.close()
		return 1
	}
	if err := json.NewEncoder(os.Stdout).Encode(h.info(ctl.url)); err != nil {
		log.Error("tunnelharness: write ready line", "err", err)
		ctl.close()
		h.close()
		return 1
	}
	log.Info("tunnelharness: ready", "control", ctl.url)

	<-ctx.Done()
	log.Info("tunnelharness: stopping")
	ctl.close()
	h.close()
	log.Info("tunnelharness: stopped")
	return 0
}

type config struct {
	dsn, token       string
	gateways, agents int
}

// readyInfo is the JSON line printed once the harness is ready.
type readyInfo struct {
	Machines []string      `json:"machines"`
	Gateways []gatewayInfo `json:"gateways"`
	Control  string        `json:"control"`
}

type gatewayInfo struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// control is the HTTP control server.
type control struct {
	url  string
	srv  *http.Server
	done chan struct{}
}

func serveControl(h *harness) (*control, error) {
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /fault", h.handleFault)
	mux.HandleFunc("GET /starts", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]int{"starts": h.starts(r.URL.Query().Get("command"))})
	})
	mux.HandleFunc("GET /labels", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]uint64{"calls": h.labelCalls(r.URL.Query().Get("command"))})
	})
	c := &control{
		url:  "http://" + ln.Addr().String(),
		srv:  &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second},
		done: make(chan struct{}),
	}
	go func() {
		defer close(c.done)
		if err := c.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.log.Error("tunnelharness: control server", "err", err)
		}
	}()
	return c, nil
}

// close waits for running fault requests, then stops the server.
func (c *control) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = c.srv.Shutdown(ctx)
	_ = c.srv.Close()
	<-c.done
}

// faultRequest is the body of POST /fault.
type faultRequest struct {
	Kind    string `json:"kind"`
	Machine string `json:"machine"`
}

func (h *harness) handleFault(w http.ResponseWriter, r *http.Request) {
	var req faultRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad body: " + err.Error()})
		return
	}
	res, err := h.fault(req.Kind, req.Machine) //nolint:contextcheck // gateways and agents started by a fault outlive the request
	var fe *faultError
	switch {
	case errors.As(err, &fe):
		writeJSON(w, fe.status, map[string]string{"error": fe.msg})
	case err != nil:
		h.log.Error("tunnelharness: fault", "kind", req.Kind, "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	default:
		h.log.Info("tunnelharness: fault injected", "kind", req.Kind, "machine", req.Machine, "result", res)
		writeJSON(w, http.StatusOK, res)
	}
}

// faultError is a fault refused with an HTTP status (400, 404, 409).
type faultError struct {
	status int
	msg    string
}

func (e *faultError) Error() string { return fmt.Sprintf("%d: %s", e.status, e.msg) }

func busy(format string, args ...any) error {
	return &faultError{status: http.StatusConflict, msg: fmt.Sprintf(format, args...)}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
