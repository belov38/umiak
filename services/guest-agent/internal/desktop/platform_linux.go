package desktop

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/pem"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// NativeSession opens the interactive OS desktop.
func NativeSession() (Session, error) { return NewX11Session() }
func secureSocket(path string) error  { return os.Chmod(path, 0600) }

// PlatformEnvironment returns the platform display environment.
func PlatformEnvironment() map[string]string {
	return map[string]string{"DISPLAY": ":0", "XAUTHORITY": "/home/user/.Xauthority"}
}

// NewPlatform binds Linux services. All starts are deferred until secrets readiness.
func NewPlatform(l paths.Layout, identityBoot string) (Session, Streamer, func(context.Context) error, error) {
	rooted := func(p string) string { r, _ := l.Rooted(p); return r }
	h := &FileHost{SunDir: rooted("/home/user/.local/state/sbx-sunshine"), MoonDir: rooted("/var/lib/sbx-stream"), Template: rooted("/etc/sbx-desktop/moonlight.json"), IceScript: "/usr/local/lib/sbx-desktop/ice-servers", Run: ExecCommand}
	h.Service = func(ctx context.Context, action, name string) error {
		unit := "sbx-sunshine.service"
		if name == "moonlight" {
			unit = "sbx-moonlight-web.service"
		}
		_, e := ExecCommand(ctx, "systemctl", action, unit)
		return e
	}
	h.Own = func(ctx context.Context, path, kind string) error {
		owner := "user:user"
		if kind == "moon" {
			owner = "sbxstream:sbxstream"
		}
		_, e := ExecCommand(ctx, "chown", "-R", "--no-dereference", owner, path)
		return e
	}
	h.Running = func(ctx context.Context) (bool, error) {
		_, e := ExecCommand(ctx, "systemctl", "is-active", "--quiet", "sbx-sunshine.service")
		if e == nil {
			return true, nil
		}
		var exit *exec.ExitError
		if errors.As(e, &exit) && (exit.ExitCode() == 3 || exit.ExitCode() == 4) {
			return false, nil
		}
		return false, e
	}
	// Sunshine generates a self-signed cert; authenticate its exact private on-disk certificate.
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error { //nolint:gosec // exact certificate pin below; endpoint is fixed loopback
		b, e := os.ReadFile(filepath.Join(h.SunDir, "cert.pem"))
		if e != nil {
			return e
		}
		block, _ := pem.Decode(b)
		if block == nil || len(cs.PeerCertificates) == 0 || !bytes.Equal(block.Bytes, cs.PeerCertificates[0].Raw) {
			return errors.New("sunshine certificate pin mismatch")
		}
		return nil
	}}}
	streamer := NewHTTPStreamer(h, &http.Client{Transport: transport}, "https://127.0.0.1:47990", "http://127.0.0.1:47800")
	marker := filepath.Join(l.RunDir, "desktop-session-boot")
	gate := SessionGate{Marker: marker, IdentityBoot: identityBoot, Run: ExecCommand}

	return SocketSession(rooted("/run/user/1000/sbx-session/socket")), streamer, gate.Start, nil
}
