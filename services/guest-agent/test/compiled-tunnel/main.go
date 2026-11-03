// Command compiled-tunnel is a subprocess fixture for gateway certificate renewal tests.
// It runs the guest agent with real TLS/WebSocket transport and OS-only fixtures.
package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/belov38/umiak/libs/tunnel/wire"
	"github.com/belov38/umiak/services/guest-agent/internal/agent"
	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/ident"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/process"
	"github.com/belov38/umiak/services/guest-agent/internal/supervisor"
)

func run() error {
	if len(os.Args) != 4 {
		panic("compiled-tunnel <root> <wss-url> <trust-dir>")
	}
	layout := paths.ForRoot(os.Args[1])
	const machine = "0192f1a4-7c3e-7b2a-9d4f-1a2b3c4d5e6f"
	if err := (&ident.File{MachineID: machine}).Save(layout.IdentityFile); err != nil {
		panic(err)
	}
	cfg := config.Defaults()
	cfg.DockerEnabled = false
	cfg.DesktopEnabled = false
	cfg.TunnelURL, cfg.TrustDir = os.Args[2], os.Args[3]
	sup := supervisor.NewFake(layout)
	defer func() { _ = sup.Close() }()
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer cancel()
	err := agent.Run(ctx, layout, cfg, "renewal-fixture", agent.Deps{
		Supervisor:   sup,
		IdentSource:  ident.Static{Raw: ident.Raw{Serial: wire.SMBIOSSerial(machine, bytes.Repeat([]byte{0x5a}, wire.SecretLen)), UUID: machine}},
		Resetter:     &ident.FakeResetter{},
		BootID:       func() (string, error) { return "11111111-2222-3333-4444-555555555555", nil },
		MountSecrets: func(dir string) error { return os.MkdirAll(dir, 0o755) },
		LookupUser: func(name string) (*process.User, error) {
			return &process.User{Name: name, UID: uint32(os.Getuid()), GID: uint32(os.Getgid()), Home: os.Args[1]}, nil
		},
		Statfs:     func(string) (uint64, uint64, error) { return 100 << 30, 50 << 30, nil },
		IdleSample: func() (float64, uint64) { return 0, 0 },
	})
	return err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
