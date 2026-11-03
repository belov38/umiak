package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

// mediaKind is one directory of template builder files and the names allowed in it.
type mediaKind struct {
	key string
	re  *regexp.Regexp
	dir func(s *Server) string
}

// The iso names are seed, build and offline ISOs plus the pinned virtio-win ISO. The user's own Windows
// ISO is deliberately not allowed here: the builder only reads it (media.sha256) and never deletes it.
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

// shaCacheEntry is one remembered digest, valid while the file keeps its size and mtime.
type shaCacheEntry struct {
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtimeNs"`
	SHA256 string `json:"sha256"`
}

func (s *Server) shaCachePath() string { return filepath.Join(s.Cfg.StateDir, "media-sha256.json") }

// loadShaCache returns the cache, or an empty one if the file is missing or unreadable: the cache is
// an optimization and never a reason to fail.
func (s *Server) loadShaCache() map[string]shaCacheEntry {
	cache := map[string]shaCacheEntry{}
	data, err := os.ReadFile(s.shaCachePath())
	if err != nil || json.Unmarshal(data, &cache) != nil || cache == nil {
		return map[string]shaCacheEntry{}
	}
	return cache
}

// saveShaCache replaces the cache file atomically. A failure is logged, not returned.
func (s *Server) saveShaCache(cache map[string]shaCacheEntry) {
	if err := s.writeShaCache(cache); err != nil && s.Log != nil {
		s.Log(fmt.Sprintf("media.sha256: cache not saved: %v", err))
	}
}

func (s *Server) writeShaCache(cache map[string]shaCacheEntry) error {
	data, err := json.Marshal(cache)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.Cfg.StateDir, 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.Cfg.StateDir, "media-sha256-*.tmp")
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), s.shaCachePath())
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}

// mediaSHA256 hashes one .iso file directly in IsoDir. Read-only and not limited to our own name
// patterns: the builder uses it to verify the user's Windows ISO.
func (s *Server) mediaSHA256(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Name    string `json:"name"`
		Storage string `json:"storage,omitempty"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	name := args.Name
	switch {
	case name == "":
		return nil, badReq("name is required")
	case strings.ContainsAny(name, "/\\\x00") || strings.Contains(name, ".."):
		return nil, forbidden("media name %q must be a plain file name", name)
	case !strings.HasSuffix(name, ".iso"):
		return nil, forbidden("media name %q is not an .iso file", name)
	}
	path := filepath.Join(s.Cfg.IsoDir, name)
	cacheKey := name
	if args.Storage != "" {
		if !regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,62}$`).MatchString(args.Storage) {
			return nil, badReq("invalid ISO storage name")
		}
		out, err := s.Host.Run(ctx, "pvesm", "path", args.Storage+":iso/"+name)
		if err != nil {
			return nil, fmt.Errorf("resolve ISO storage: %w", err)
		}
		path = strings.TrimSpace(string(out))
		if !filepath.IsAbs(path) || filepath.Base(path) != name {
			return nil, forbidden("invalid PVE ISO path")
		}
		cacheKey = args.Storage + ":" + path
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, forbidden("media %q is not a regular file", name)
	}

	cache := s.loadShaCache()
	if e, ok := cache[cacheKey]; ok && e.Size == info.Size() && e.MTime == info.ModTime().UnixNano() {
		return map[string]any{"name": name, "size": e.Size, "sha256": e.SHA256}, nil
	}

	// O_NOFOLLOW and the SameFile check close the window between Lstat and open.
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0) //nolint:gosec // name is validated above
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	opened, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return nil, forbidden("media %q changed while opening", name)
	}
	if s.OnHash != nil {
		s.OnHash(name)
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	// Cache only if the file did not change while it was being read.
	if after, err := f.Stat(); err == nil && after.Size() == opened.Size() && after.ModTime().Equal(opened.ModTime()) {
		cache[cacheKey] = shaCacheEntry{Size: opened.Size(), MTime: opened.ModTime().UnixNano(), SHA256: sum}
		s.saveShaCache(cache)
	}
	return map[string]any{"name": name, "size": opened.Size(), "sha256": sum}, nil
}
