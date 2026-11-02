package desktop

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// NativeSession opens the interactive OS desktop.
func NativeSession(_ context.Context) (Session, error)  { return NewX11Session() }
func secureSocket(_ context.Context, path string) error { return os.Chmod(path, 0600) }

// PlatformEnvironment returns the platform display environment.
func PlatformEnvironment() map[string]string {
	return map[string]string{"DISPLAY": ":0", "XAUTHORITY": "/home/user/.Xauthority"}
}

// NewPlatform binds Linux services. All starts are deferred until secrets readiness.
func NewPlatform(l paths.Layout, identityBoot string) (Session, Streamer, func(context.Context) error, error) {
	rooted := func(p string) string { r, _ := l.Rooted(p); return r }
	h := &FileHost{SunDir: rooted("/home/user/.local/state/umiak-sunshine"), MoonDir: rooted("/var/lib/umiak-stream"), Template: rooted("/etc/umiak-desktop/moonlight.json"), IceScript: "/usr/local/lib/umiak-desktop/ice-servers", Run: ExecCommand}
	h.FlowTimeout = func() (uint32, error) {
		data, e := os.ReadFile(rooted("/proc/sys/net/netfilter/nf_conntrack_udp_timeout_stream"))
		if e != nil {
			return 0, e
		}
		ttl, e := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32)
		return uint32(ttl), e
	}
	h.Service = func(ctx context.Context, action, name string) error {
		unit := "umiak-sunshine.service"
		if name == "moonlight" {
			unit = "umiak-moonlight-web.service"
		}
		_, e := ExecCommand(ctx, "systemctl", action, unit)
		return e
	}
	h.Own = func(ctx context.Context, path, kind string) error {
		owner := "user:user"
		if kind == "moon" {
			owner = "umiakstream:umiakstream"
		}
		if kind == "sun" {
			if e := ownUserDesktopParents(ctx, path, ExecCommand); e != nil {
				return e
			}
		}
		_, e := ExecCommand(ctx, "chown", "-R", "--no-dereference", owner, path)
		return e
	}
	h.Running = func(ctx context.Context) (bool, error) {
		_, e := ExecCommand(ctx, "systemctl", "is-active", "--quiet", "umiak-sunshine.service")
		if e == nil {
			return true, nil
		}
		var exit *exec.ExitError
		if errors.As(e, &exit) && (exit.ExitCode() == 3 || exit.ExitCode() == 4) {
			return false, nil
		}
		return false, e
	}
	streamer := NewHTTPStreamer(h, pinnedSunshineClient(filepath.Join(h.SunDir, "cert.pem")), "https://127.0.0.1:47990", "http://127.0.0.1:47800")
	marker := filepath.Join(l.RunDir, "desktop-session-boot")
	gate := SessionGate{Marker: marker, IdentityBoot: identityBoot, Run: ExecCommand}

	return SocketSession(rooted("/run/user/1000/umiak-session/socket")), streamer, gate.Start, nil
}
