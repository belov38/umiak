package desktop

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	v1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// TestRuntimeConfigRotationAndICERefresh implements the desktop adapter boundary.
func TestRuntimeConfigRotationAndICERefresh(t *testing.T) {
	root := t.TempDir()
	var calls []string
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return nil, nil
	}
	h := &FileHost{SunDir: filepath.Join(root, "sun"), MoonDir: filepath.Join(root, "moon"), Template: filepath.Join(root, "template.json"), Run: run, Service: func(ctx context.Context, action, unit string) error {
		_, e := run(ctx, "systemctl", action, unit)
		return e
	}}
	_ = os.WriteFile(h.Template, []byte(`{"web_server":{},"webrtc":{},"data_storage":{"type":"json"}}`), 0600)
	ice := []*v1.DesktopIceServer{{Urls: []string{"turn:turn.example:3478"}, Username: "expiry:id", Credential: "issued"}}
	reset, e := h.Prepare(context.Background(), Credentials{"u", "p"}, ice)
	if e != nil || !reset {
		t.Fatal(reset, e)
	}
	_ = os.WriteFile(filepath.Join(h.MoonDir, "data.json"), []byte("paired"), 0600)
	reset, e = h.Prepare(context.Background(), Credentials{"u", "p"}, ice)
	if e != nil || reset {
		t.Fatal(reset, e)
	}
	if _, e = os.Stat(filepath.Join(h.MoonDir, "data.json")); e != nil {
		t.Fatal("same identity lost pairing")
	}
	reset, e = h.Prepare(context.Background(), Credentials{"new", "fresh"}, ice)
	if e != nil || !reset {
		t.Fatal(reset, e)
	}
	if _, e = os.Stat(filepath.Join(h.MoonDir, "data.json")); !os.IsNotExist(e) {
		t.Fatal("fork retained upstream database")
	}
	b, _ := os.ReadFile(filepath.Join(h.MoonDir, "config.json"))
	var c map[string]any
	if e = json.Unmarshal(b, &c); e != nil {
		t.Fatal(e)
	}
	if c["web_server"].(map[string]any)["bind_address"] != "127.0.0.1:47800" {
		t.Fatal("stream exposed")
	}
	if strings.Contains(string(b), "stun.l.google") || len(calls) < 2 {
		t.Fatal("unsafe defaults or no process stop on rotate")
	}
	info, _ := os.Stat(filepath.Join(h.MoonDir, "ice-servers.json"))
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("public ICE credentials")
	}
}
