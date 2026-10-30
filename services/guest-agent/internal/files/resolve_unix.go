//go:build !windows

package files

import (
	"path/filepath"
	"strings"
)

// resolveOS resolves a non-empty path without NUL bytes under home.
func resolveOS(p, home string) (string, error) {
	switch {
	case p == "~":
		p = home
	case strings.HasPrefix(p, "~/"):
		p = filepath.Join(home, p[2:])
	case !filepath.IsAbs(p):
		p = filepath.Join(home, p)
	}
	return filepath.Clean(p), nil
}
