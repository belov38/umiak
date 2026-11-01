package desktop

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// NativeSession opens the logged-in console desktop, never session zero.
func NativeSession(ctx context.Context) (Session, error) {
	api, e := newWin32Desktop(ctx)
	if e != nil {
		return nil, e
	}
	return &WinSession{API: api}, nil
}
func secureSocket(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return windowsACL(ctx, path, "user")
}

// PlatformEnvironment leaves Windows display selection to the interactive helper.
func PlatformEnvironment() map[string]string { return nil }
func windowsACL(ctx context.Context, path, account string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	for _, args := range aclCommands(path, account, info.IsDir(), childNames(path, info.IsDir())) {
		if _, e := ExecCommand(ctx, "icacls.exe", args...); e != nil {
			return e
		}
	}
	return nil
}

func childNames(dir string, isDir bool) []string {
	if !isDir {
		return nil
	}
	entries, _ := os.ReadDir(dir)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

type scmService struct{ service *mgr.Service }

func (s scmService) Query() (uint32, error) {
	state, e := s.service.Query()
	return uint32(state.State), e
}
func (s scmService) Start() error { return s.service.Start() }
func (s scmService) Stop() error  { _, e := s.service.Control(svc.Stop); return e }
func openService(name string) (*mgr.Mgr, *mgr.Service, error) {
	m, e := mgr.Connect()
	if e != nil {
		return nil, nil, e
	}
	s, e := m.OpenService(name)
	if e != nil {
		_ = m.Disconnect()
		return nil, nil, e
	}
	return m, s, nil
}
func windowsService(ctx context.Context, action, name string) error {
	m, s, e := openService(name)
	if e != nil {
		return e
	}
	defer func() { _ = s.Close(); _ = m.Disconnect() }()
	return controlService(ctx, scmService{s}, action)
}

// NewPlatform binds the S9 Windows layout to the shared desktop RPC implementation.
func NewPlatform(l paths.Layout, _ string) (Session, Streamer, func(context.Context) error, error) {
	files := os.Getenv("ProgramFiles")
	if files == "" {
		files = `C:\Program Files`
	}
	configDir := filepath.Join(filepath.Dir(l.StateDir), "desktop")
	h := &FileHost{SunDir: filepath.Join(files, "Sunshine", "config"), MoonDir: filepath.Join(l.StateDir, "desktop-moonlight"), Template: filepath.Join(configDir, "moonlight.json"), IceScript: filepath.Join(configDir, "ice-servers.cmd"), Capture: "ddx"}
	h.StreamSockets = moonlightUDPSockets
	h.Run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "conntrack" {
			return nil, errors.New("windows conntrack unavailable")
		}
		return ExecCommand(ctx, name, args...)
	}
	h.Service = func(ctx context.Context, action, name string) error {
		unit := "SunshineService"
		if name == "moonlight" {
			unit = "sbx-moonlight-web"
		}
		return windowsService(ctx, action, unit)
	}
	h.Running = func(context.Context) (bool, error) {
		m, s, e := openService("SunshineService")
		if e != nil {
			return false, e
		}
		defer func() { _ = s.Close(); _ = m.Disconnect() }()
		state, e := s.Query()
		return state.State == svc.Running, e
	}
	h.Own = func(ctx context.Context, path, kind string) error {
		account := "user"
		if kind == "moon" {
			account = `NT SERVICE\sbx-moonlight-web`
		}
		return windowsACL(ctx, path, account)
	}
	socket := filepath.Join(l.RunDir, "desktop-session", "socket")
	start := func(ctx context.Context) error {
		if e := os.MkdirAll(filepath.Dir(socket), 0700); e != nil {
			return e
		}
		if e := windowsACL(ctx, filepath.Dir(socket), "user"); e != nil {
			return e
		}
		_, e := ExecCommand(ctx, filepath.Join(files, "PowerShell", "7", "pwsh.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-File", filepath.Join(configDir, "register-session.ps1"), "-Socket", socket)
		return e
	}
	streamer := NewHTTPStreamer(h, pinnedSunshineClient(filepath.Join(h.SunDir, "cert.pem")), "https://127.0.0.1:47990", "http://127.0.0.1:47800")
	return SocketSession(socket), streamer, start, nil
}
