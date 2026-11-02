package desktop

import (
	"context"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	v1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
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
	reset, e := h.Prepare(context.Background(), Credentials{Username: "u", Password: "p"}, ice)
	if e != nil || !reset {
		t.Fatal(reset, e)
	}
	_ = os.WriteFile(filepath.Join(h.MoonDir, "data.json"), []byte("paired"), 0600)
	reset, e = h.Prepare(context.Background(), Credentials{Username: "u", Password: "p"}, ice)
	if e != nil || reset {
		t.Fatal(reset, e)
	}
	if _, e = os.Stat(filepath.Join(h.MoonDir, "data.json")); e != nil {
		t.Fatal("same identity lost pairing")
	}
	reset, e = h.Prepare(context.Background(), Credentials{Username: "new", Password: "fresh", MoonlightPassword: "moon-fresh"}, ice)
	if e != nil || !reset {
		t.Fatal(reset, e)
	}
	seed, _ := os.ReadFile(filepath.Join(h.MoonDir, "data.json"))
	var store struct {
		Version string `json:"version"`
		Users   map[string]struct {
			RoleID   int    `json:"role_id"`
			Name     string `json:"name"`
			Password struct {
				Salt, Hash string
				Iterations int
			} `json:"password"`
		} `json:"users"`
		Roles map[string]struct{ Ty string } `json:"roles"`
	}
	if e = json.Unmarshal(seed, &store); e != nil || string(seed) == "paired" {
		t.Fatalf("fork retained upstream database or no seed: %v", e)
	}
	admin := store.Users["0"]
	if store.Version != "3" || admin.Name != "new" || admin.RoleID != 0 || store.Roles["0"].Ty != "Admin" || len(store.Users) != 1 {
		t.Fatalf("seed is not one administrator: %s", seed)
	}
	salt, _ := hex.DecodeString(admin.Password.Salt)
	want, _ := pbkdf2.Key(sha256.New, "moon-fresh", salt, admin.Password.Iterations, 32)
	if admin.Password.Hash != hex.EncodeToString(want) || admin.Password.Iterations != 600_000 {
		t.Fatal("administrator password hash does not verify with the moonlight secret")
	}
	b, _ := os.ReadFile(filepath.Join(h.MoonDir, "config.json"))
	var c map[string]any
	if e = json.Unmarshal(b, &c); e != nil {
		t.Fatal(e)
	}
	if c["web_server"].(map[string]any)["first_login_create_admin"] != false {
		t.Fatal("the first /api/login could still create the administrator")
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

// TestMoonlightPasswordHashMatchesUpstream checks the PBKDF2 parameters
// against the upstream v3.0.1 test vector (src/app/password.rs).
func TestMoonlightPasswordHashMatchesUpstream(t *testing.T) {
	salt, _ := hex.DecodeString("847040fce304a9bef9e7727f50f40d06")
	got, err := pbkdf2.Key(sha256.New, "test", salt, moonlightHashIterations, 32)
	if err != nil || hex.EncodeToString(got) != "a0d31b674cb2f97eaa3ac1366553db59e1a7b8c9d47cf210194a15fdd268c597" {
		t.Fatalf("hash %x %v", got, err)
	}
}
