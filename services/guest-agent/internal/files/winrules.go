package files

import (
	"path"
	"strings"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// The Windows rules are plain string functions, so they are tested on every
// platform; only the Windows build uses them.

// defaultPathext is PATHEXT of a fresh Windows 11.
const defaultPathext = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL"

// windowsPath resolves a request path by the Windows rules (S9 spec 12.9):
// "C:\x" and "C:/x" (any drive letter, either case) are absolute; "~",
// "~\x" and "~/x" are under home, other relative paths are relative to
// home. UNC and device paths ("\\server\s", "\\?\", "\\.\"), paths rooted
// without a drive ("\x") and drive-relative paths ("C:x") are invalid_path.
// The result is clean, uses backslashes and an upper-case drive letter.
func windowsPath(p, home string) (string, error) {
	if p == "" {
		return "", errs.New(connect.CodeInvalidArgument, errs.InvalidPath, "path is empty")
	}
	if strings.IndexByte(p, 0) >= 0 {
		return "", errs.New(connect.CodeInvalidArgument, errs.InvalidPath, "path contains a NUL byte")
	}
	s := strings.ReplaceAll(p, "/", `\`)
	switch {
	case strings.HasPrefix(s, `\\`):
		return "", errs.Newf(connect.CodeInvalidArgument, errs.InvalidPath, "%q: UNC and device paths are not supported", p)
	case strings.HasPrefix(s, `\`):
		return "", errs.Newf(connect.CodeInvalidArgument, errs.InvalidPath, "%q: the path has no drive letter", p)
	case hasDrive(s):
		if len(s) < 3 || s[2] != '\\' {
			return "", errs.Newf(connect.CodeInvalidArgument, errs.InvalidPath, "%q: drive-relative paths are not supported", p)
		}
	default:
		h := strings.ReplaceAll(home, "/", `\`)
		if !hasDrive(h) || len(h) < 3 || h[2] != '\\' {
			return "", errs.Newf(connect.CodeInternal, errs.Internal, "home %q is not an absolute path", home)
		}
		switch {
		case s == "~":
			s = h
		case strings.HasPrefix(s, `~\`):
			s = h + s[1:]
		default:
			s = h + `\` + s
		}
	}
	rest := path.Clean(strings.ReplaceAll(s[2:], `\`, "/"))
	return strings.ToUpper(s[:1]) + ":" + strings.ReplaceAll(rest, "/", `\`), nil
}

// hasDrive reports whether s starts with a drive letter and a colon.
func hasDrive(s string) bool {
	if len(s) < 2 || s[1] != ':' {
		return false
	}
	c := s[0] | 0x20
	return c >= 'a' && c <= 'z'
}

// synthMode is the Unix mode reported for a Windows file (S9 spec 12.9): a
// directory 0755, a file 0644, without the write bits when the read-only
// attribute is set, plus 0111 for a file whose extension is in pathext (an
// empty pathext is the Windows default). Links are 0777, like on Linux.
func synthMode(name string, dir, link, readOnly bool, pathext string) uint32 {
	if link {
		return 0o777
	}
	mode := uint32(0o644)
	if dir || isExecutableName(name, pathext) {
		mode = 0o755
	}
	if readOnly {
		mode &^= 0o222
	}
	return mode
}

// isExecutableName reports whether the extension of name is in pathext.
func isExecutableName(name, pathext string) bool {
	i := strings.LastIndexByte(name, '.')
	if i < 0 {
		return false
	}
	if pathext == "" {
		pathext = defaultPathext
	}
	ext := name[i:]
	for e := range strings.SplitSeq(pathext, ";") {
		if e != "" && strings.EqualFold(strings.TrimSpace(e), ext) {
			return true
		}
	}
	return false
}
