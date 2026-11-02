package files

import (
	"errors"
	"path/filepath"
	"runtime"
	"testing"

	"connectrpc.com/connect"

	"github.com/belov38/umiak/libs/tunnel/rpcconv"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
	"github.com/belov38/umiak/services/guest-agent/internal/process"
)

func TestResolveHome(t *testing.T) {
	// Absolute paths need a drive letter on Windows (TestWindowsPathRules).
	home, abs := filepath.FromSlash("/home/user"), ""
	if runtime.GOOS == "windows" {
		home, abs = `C:\Users\user`, "C:"
	}
	u := &process.User{Name: "user", Home: home}
	tests := []struct {
		in   string
		want string
	}{
		{"~", home},
		{"~/a", filepath.Join(home, "a")},
		{"~/a/../b", filepath.Join(home, "b")},
		{"a", filepath.Join(home, "a")},
		{"a/b/", filepath.Join(home, "a", "b")},
		{"./a", filepath.Join(home, "a")},
		{abs + "/etc//passwd", abs + filepath.FromSlash("/etc/passwd")},
		{abs + "/a/../b", abs + filepath.FromSlash("/b")},
	}
	for _, tt := range tests {
		got, err := Resolve(tt.in, u)
		if err != nil {
			t.Errorf("Resolve(%q): %v", tt.in, err)
			continue
		}
		if got != tt.want {
			t.Errorf("Resolve(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestResolveInvalid(t *testing.T) {
	u := &process.User{Name: "user", Home: "/home/user"}
	for _, in := range []string{"", "a\x00b", "/x\x00"} {
		_, err := Resolve(in, u)
		var cerr *connect.Error
		if !errors.As(err, &cerr) || cerr.Code() != connect.CodeInvalidArgument {
			t.Errorf("Resolve(%q) = %v, want invalid_argument", in, err)
			continue
		}
		if d, ok := rpcconv.Detail(cerr); !ok || d.GetCode() != errs.InvalidPath {
			t.Errorf("Resolve(%q) detail = %v, want %s", in, d, errs.InvalidPath)
		}
	}
}
