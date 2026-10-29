package files

import (
	"path/filepath"
	"strings"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
)

// Resolve turns a request path into a clean absolute path (spec 11.1): "~",
// "~/..." and relative paths are resolved under the home directory of u. An
// empty path or one with a NUL byte is invalid_path. There are no other
// restrictions: the trust boundary is the VM.
func Resolve(p string, u *process.User) (string, error) {
	if p == "" {
		return "", errs.New(connect.CodeInvalidArgument, errs.InvalidPath, "path is empty")
	}
	if strings.IndexByte(p, 0) >= 0 {
		return "", errs.New(connect.CodeInvalidArgument, errs.InvalidPath, "path contains a NUL byte")
	}
	switch {
	case p == "~":
		p = u.Home
	case strings.HasPrefix(p, "~/"):
		p = filepath.Join(u.Home, p[2:])
	case !filepath.IsAbs(p):
		p = filepath.Join(u.Home, p)
	}
	return filepath.Clean(p), nil
}
