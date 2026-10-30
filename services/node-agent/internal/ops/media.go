package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// mediaKind is one directory of template builder files and the names allowed in it.
type mediaKind struct {
	key string
	re  *regexp.Regexp
	dir func(s *Server) string
}

var mediaKinds = []mediaKind{
	{"iso", mediaISORe, func(s *Server) string { return s.Cfg.IsoDir }},
	{"import", mediaImgRe, func(s *Server) string { return s.Cfg.ImportDir }},
}

// matches reports whether name is an allowed file name for this directory.
func (k mediaKind) matches(name string) bool {
	return k.re.MatchString(name) && !strings.Contains(name, "..")
}

// MediaFile is one file in a media.list result.
type MediaFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func (s *Server) mediaList(_ context.Context, raw json.RawMessage) (any, error) {
	if err := decodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	res := map[string]any{}
	for _, k := range mediaKinds {
		files := []MediaFile{}
		entries, err := os.ReadDir(k.dir(s))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		for _, e := range entries {
			if !k.matches(e.Name()) {
				continue
			}
			// Lstat, not Stat: a symlink must never be listed as a removable file.
			info, err := os.Lstat(filepath.Join(k.dir(s), e.Name()))
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			files = append(files, MediaFile{Name: e.Name(), Size: info.Size()})
		}
		res[k.key] = files
	}
	return res, nil
}

func (s *Server) mediaRemove(_ context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Names []string `json:"names"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	removed, missing := []string{}, []string{}
	var todo []string
	for _, n := range args.Names {
		path := ""
		for _, k := range mediaKinds {
			if k.matches(n) {
				path = filepath.Join(k.dir(s), n)
			}
		}
		if path == "" {
			return nil, forbidden("media name %q is not allowed", n)
		}
		info, err := os.Lstat(path)
		if errors.Is(err, fs.ErrNotExist) {
			missing = append(missing, n)
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, forbidden("media %q is not a regular file", n)
		}
		todo = append(todo, path)
	}
	for _, path := range todo {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("remove %s (removed so far %v): %w", filepath.Base(path), removed, err)
		}
		removed = append(removed, filepath.Base(path))
	}
	return map[string]any{"removed": removed, "missing": missing}, nil
}
