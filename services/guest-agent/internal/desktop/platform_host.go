package desktop

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
)

// RunCommand is the injectable OS command boundary.
type RunCommand func(context.Context, string, ...string) ([]byte, error)

// ExecCommand runs a bounded OS command with the supplied context.
func ExecCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// FileHost owns the private per-identity upstream databases; OS services only launch them.
type FileHost struct {
	SunDir, MoonDir, Template, IceScript string
	Capture                              string
	Run                                  RunCommand
	Service                              func(context.Context, string, string) error
	Own                                  func(context.Context, string, string) error
	Running                              func(context.Context) (bool, error)
	mu                                   sync.Mutex
}

// Prepare rotates private state when the machine identity changes.
func (h *FileHost) Prepare(ctx context.Context, c Credentials, ice []*v1.DesktopIceServer) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	hash := sha256.Sum256([]byte(c.Username + ":" + c.Password))
	fingerprint := hex.EncodeToString(hash[:])
	marker := filepath.Join(h.MoonDir, "identity-hash")
	old, _ := os.ReadFile(marker)
	reset := string(old) != fingerprint
	if reset {
		if e := h.Stop(ctx); e != nil {
			return false, e
		}
		for _, dir := range []string{h.SunDir, h.MoonDir} {
			if e := os.RemoveAll(dir); e != nil {
				return false, e
			}
			if e := os.MkdirAll(dir, 0700); e != nil {
				return false, e
			}
		}
		b, e := os.ReadFile(h.Template)
		if e != nil {
			return false, e
		}
		var cfg map[string]any
		if e = json.Unmarshal(b, &cfg); e != nil {
			return false, e
		}
		for _, k := range []string{"web_server", "webrtc", "data_storage"} {
			if _, ok := cfg[k].(map[string]any); !ok {
				return false, fmt.Errorf("upstream config missing %s", k)
			}
		}
		web := cfg["web_server"].(map[string]any)
		web["bind_address"] = "127.0.0.1:47800"
		web["first_login_create_admin"] = true
		web["first_login_assign_global_hosts"] = false
		web["forwarded_header"] = map[string]any{"username_header": "X-Sbx-Desktop-User", "auto_create_missing_user": false}
		rtc := cfg["webrtc"].(map[string]any)
		rtc["ice_servers"] = []any{}
		if h.IceScript != "" {
			rtc["ice_server_script"] = h.IceScript
		}
		cfg["data_storage"].(map[string]any)["path"] = filepath.Join(h.MoonDir, "data.json")
		b, e = json.MarshalIndent(cfg, "", "  ")
		if e != nil {
			return false, e
		}
		if e = fsutil.WriteFileAtomic(filepath.Join(h.MoonDir, "config.json"), b, 0600); e != nil {
			return false, e
		}
		capture := h.Capture
		if capture == "" {
			capture = "x11"
		}
		conf := fmt.Sprintf("bind_address = 127.0.0.1\naddress_family = ipv4\nupnp = disabled\norigin_web_ui_allowed = pc\ncapture = %s\nencoder = software\nsw_preset = superfast\nsw_tune = zerolatency\nstream_audio = disabled\nmin_log_level = info\nfile_state = %s\ncredentials_file = %s\nfile_apps = %s\nlog_path = %s\ncert = %s\npkey = %s\n", capture, filepath.Join(h.SunDir, "state.json"), filepath.Join(h.SunDir, "credentials.json"), filepath.Join(h.SunDir, "apps.json"), filepath.Join(h.SunDir, "sunshine.log"), filepath.Join(h.SunDir, "cert.pem"), filepath.Join(h.SunDir, "key.pem"))
		if e = fsutil.WriteFileAtomic(filepath.Join(h.SunDir, "sunshine.conf"), []byte(conf), 0600); e != nil {
			return false, e
		}
		if e = fsutil.WriteFileAtomic(filepath.Join(h.SunDir, "apps.json"), []byte(`{"env":{},"apps":[{"name":"Desktop","image-path":"","cmd":""}]}`), 0600); e != nil {
			return false, e
		}
	}
	if e := h.writeICE(ice); e != nil {
		return false, e
	}
	if h.Own != nil {
		if e := h.Own(ctx, h.SunDir, "sun"); e != nil {
			return false, e
		}
		if e := h.Own(ctx, h.MoonDir, "moon"); e != nil {
			return false, e
		}
	}
	// Commit the identity marker only after every config and permission operation succeeded.
	if e := fsutil.WriteFileAtomic(marker, []byte(fingerprint), 0600); e != nil {
		return false, e
	}
	if h.Own != nil {
		if e := h.Own(ctx, marker, "moon"); e != nil {
			return false, e
		}
	}
	return reset, nil
}
func (h *FileHost) writeICE(ice []*v1.DesktopIceServer) error {
	if ice == nil {
		ice = []*v1.DesktopIceServer{}
	}
	b, e := json.Marshal(ice)
	if e != nil {
		return e
	}
	return fsutil.WriteFileAtomic(filepath.Join(h.MoonDir, "ice-servers.json"), b, 0600)
}

// Configure refreshes issued ICE credentials atomically.
func (h *FileHost) Configure(ctx context.Context, ice []*v1.DesktopIceServer) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, e := os.Stat(filepath.Join(h.MoonDir, "identity-hash")); os.IsNotExist(e) {
		return nil
	}
	if e := h.writeICE(ice); e != nil {
		return e
	}
	if h.Own != nil {
		return h.Own(ctx, filepath.Join(h.MoonDir, "ice-servers.json"), "moon")
	}
	return nil
}

// Start starts both manual streaming services.
func (h *FileHost) Start(ctx context.Context) error {
	if e := h.Service(ctx, "start", "sunshine"); e != nil {
		return e
	}
	return h.Service(ctx, "start", "moonlight")
}

// Stop stops both streaming services.
func (h *FileHost) Stop(ctx context.Context) error {
	return errors.Join(h.Service(ctx, "stop", "moonlight"), h.Service(ctx, "stop", "sunshine"))
}

// RestartWeb disconnects all upstream browser sessions.
func (h *FileHost) RestartWeb(ctx context.Context) error {
	return h.Service(ctx, "restart", "moonlight")
}

// Viewers samples observed active media clients.
func (h *FileHost) Viewers(ctx context.Context) (uint32, error) {
	if h.Running != nil {
		running, e := h.Running(ctx)
		if e != nil {
			return 0, e
		}
		if !running {
			return 0, nil
		}
	}
	// Pinned Sunshine logs one CONNECT/DISCONNECT per ENet control session.
	file, e := os.Open(filepath.Join(h.SunDir, "sunshine.log"))
	var count uint32
	if e == nil {
		data, err := io.ReadAll(io.LimitReader(file, 16<<20+1))
		_ = file.Close()
		e = err
		if len(data) > 16<<20 {
			e = errors.New("stream log exceeds scan budget")
		} else if e == nil {
			count = viewerLogCount(string(data))
		}
	}
	// Conntrack ASSURED control flows cover a missing/rotated log conservatively.
	data, ce := h.Run(ctx, "conntrack", "-L", "-p", "udp", "--dport", "47999", "-o", "extended")
	if ce == nil {
		return max(count, conntrackViewers(string(data))), nil
	}
	if e == nil {
		return count, nil
	}
	return 0, errors.Join(e, ce)
}

// Configure refreshes issued ICE credentials atomically.
func (s *HTTPStreamer) Configure(ctx context.Context, ice []*v1.DesktopIceServer) error {
	if h, ok := s.host.(interface {
		Configure(context.Context, []*v1.DesktopIceServer) error
	}); ok {
		return h.Configure(ctx, ice)
	}
	return nil
}
