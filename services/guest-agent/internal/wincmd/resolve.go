package wincmd

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrNotFound is returned when no executable file matches the program name.
var ErrNotFound = errors.New("wincmd: program not found")

// defaultPathext applies when the environment has no PATHEXT.
const defaultPathext = ".COM;.EXE;.BAT;.CMD"

// ResolveProgram finds the file that runs for program name, the way
// CreateProcess and cmd.exe do, with PATH and PATHEXT taken from env
// (case-insensitive keys). A name with a separator or a drive is a path,
// relative to cwd; a bare name is searched in the absolute PATH entries only
// (never in cwd). A name with an extension is tried as is first; then each
// PATHEXT extension is appended. isBatch is true for .bat and .cmd files.
func ResolveProgram(name string, env []string, cwd string) (path string, isBatch bool, err error) {
	if name == "" {
		return "", false, fmt.Errorf("%w: empty name", ErrNotFound)
	}
	exts := pathext(env)
	if strings.ContainsAny(name, `/\`) || filepath.VolumeName(name) != "" {
		p := name
		if !filepath.IsAbs(p) {
			p = filepath.Join(cwd, p)
		}
		if f, ok := findExecutable(p, exts); ok {
			return f, IsBatch(f), nil
		}
		return "", false, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	pathVar, _ := Lookup(env, "PATH")
	for _, dir := range splitPath(pathVar) {
		if !filepath.IsAbs(dir) {
			continue
		}
		if f, ok := findExecutable(filepath.Join(dir, name), exts); ok {
			return f, IsBatch(f), nil
		}
	}
	return "", false, fmt.Errorf("%w: %s", ErrNotFound, name)
}

// pathext returns the lowercase PATHEXT extensions of env.
func pathext(env []string) []string {
	v, _ := Lookup(env, "PATHEXT")
	if strings.TrimSpace(v) == "" {
		v = defaultPathext
	}
	var exts []string
	for e := range strings.SplitSeq(v, ";") {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			continue
		}
		if e[0] != '.' {
			e = "." + e
		}
		exts = append(exts, e)
	}
	return exts
}

// findExecutable returns the first regular file among p (when p has an
// extension) and p with each of exts appended.
func findExecutable(p string, exts []string) (string, bool) {
	if hasExt(p) && isFile(p) {
		return p, true
	}
	for _, e := range exts {
		if isFile(p + e) {
			return p + e, true
		}
	}
	return "", false
}

// hasExt reports whether the last element of p has an extension.
func hasExt(p string) bool {
	i := strings.LastIndexAny(p, `:\/.`)
	return i >= 0 && p[i] == '.'
}

func isFile(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular()
}

// splitPath splits a PATH value at semicolons outside double quotes and
// drops the quotes, like cmd.exe.
func splitPath(v string) []string {
	var out []string
	var cur strings.Builder
	quoted := false
	for _, r := range v {
		switch {
		case r == '"':
			quoted = !quoted
		case r == ';' && !quoted:
			if cur.Len() > 0 {
				out = append(out, cur.String())
			}
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}
