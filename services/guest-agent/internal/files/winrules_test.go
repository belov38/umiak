package files

import (
	"errors"
	"testing"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/libs/tunnel/rpcconv"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

func TestWindowsPathRules(t *testing.T) {
	const home = `C:\Users\user`
	ok := []struct{ in, want string }{
		{`C:/x`, `C:\x`},
		{`c:\X\..\Y`, `C:\Y`},
		{`C:\`, `C:\`},
		{`C:/`, `C:\`},
		{`d:\a\\b\.\c\`, `D:\a\b\c`},
		{`C:\..\..\x`, `C:\x`},
		{`C:\a/b\c`, `C:\a\b\c`},
		{`~`, home},
		{`~\x`, home + `\x`},
		{`~/x/y`, home + `\x\y`},
		{`~\..\other`, `C:\Users\other`},
		{`x`, home + `\x`},
		{`a/b`, home + `\a\b`},
		{`.\x\..\y`, home + `\y`},
		{`..\other`, `C:\Users\other`},
		{`~x`, home + `\~x`},
	}
	for _, tt := range ok {
		got, err := windowsPath(tt.in, home)
		if err != nil {
			t.Errorf("windowsPath(%q): %v", tt.in, err)
			continue
		}
		if got != tt.want {
			t.Errorf("windowsPath(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
	bad := []string{
		``,
		`\\server\s`,
		`//server/s`,
		`\\?\C:\x`,
		`//?/C:/x`,
		`\\.\pipe\x`,
		`\\.\C:`,
		`\??\C:\x`,
		`C:x`,
		`c:..\x`,
		`C:`,
		`\x`,
		`/x`,
	}
	for _, in := range bad {
		_, err := windowsPath(in, home)
		var cerr *connect.Error
		if !errors.As(err, &cerr) || cerr.Code() != connect.CodeInvalidArgument {
			t.Errorf("windowsPath(%q) = %v, want invalid_argument", in, err)
			continue
		}
		if d, ok := rpcconv.Detail(cerr); !ok || d.GetCode() != errs.InvalidPath {
			t.Errorf("windowsPath(%q) detail = %v, want %s", in, d, errs.InvalidPath)
		}
	}
	// A home that is not drive-absolute cannot anchor relative paths.
	if _, err := windowsPath(`x`, ``); err == nil {
		t.Error("windowsPath with an empty home succeeded")
	}
}

func TestSynthMode(t *testing.T) {
	const pathext = ".COM;.EXE;.BAT;.CMD"
	tests := []struct {
		name                string
		dir, link, readOnly bool
		pathext             string
		want                uint32
	}{
		{name: "d", dir: true, want: 0o755},
		{name: "d", dir: true, readOnly: true, want: 0o555},
		{name: "a.txt", want: 0o644},
		{name: "a.txt", readOnly: true, want: 0o444},
		{name: "run.exe", want: 0o755},
		{name: "RUN.Cmd", want: 0o755},
		{name: "run.EXE", readOnly: true, want: 0o555},
		{name: "noext", want: 0o644},
		{name: "x.ps1", want: 0o644},
		{name: "x.exe.txt", want: 0o644},
		{name: "l", link: true, want: 0o777},
		{name: "l.exe", link: true, readOnly: true, want: 0o777},
		{name: "d.exe", dir: true, want: 0o755},
	}
	for _, tt := range tests {
		pe := tt.pathext
		if pe == "" {
			pe = pathext
		}
		if got := synthMode(tt.name, tt.dir, tt.link, tt.readOnly, pe); got != tt.want {
			t.Errorf("synthMode(%q, dir=%v, link=%v, ro=%v) = %o, want %o", tt.name, tt.dir, tt.link, tt.readOnly, got, tt.want)
		}
	}
	// An empty PATHEXT falls back to the Windows default.
	if got := synthMode("x.bat", false, false, false, ""); got != 0o755 {
		t.Errorf("synthMode with empty PATHEXT = %o, want 755", got)
	}
}
