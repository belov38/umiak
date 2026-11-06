package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"syscall"
	"time"
)

// layerBase rehashes the official base on the target node, never trusting a size/mtime cache.
func (s *Server) layerBase(ctx context.Context, raw json.RawMessage) (any, error) {
	_, m, e := s.layerRequest(raw, false)
	if e != nil {
		return nil, e
	}
	name := "umiak-ubuntu-26.04-minimal-" + m.Base.Serial + ".qcow2"
	path := filepath.Join(s.Cfg.ImportDir, name)
	file, e := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0) //nolint:gosec // name is derived solely from verified signed base serial
	if os.IsNotExist(e) {
		return map[string]any{"name": name, "verified": false}, nil
	}
	if e != nil {
		return nil, e
	}
	defer func() { _ = file.Close() }()
	info, e := file.Stat()
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 8<<30 {
		return nil, forbidden("official base is not a regular file")
	}
	hash := sha256.New()
	buffer := make([]byte, 1024*1024)
	var size int64
	last := time.Now()
	for {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		n, err := file.Read(buffer)
		if n > 0 {
			_, _ = hash.Write(buffer[:n])
			size += int64(n)
		}
		if s.Progress != nil && time.Since(last) >= 5*time.Second {
			if e = s.Progress(map[string]any{"hashedBytes": size}); e != nil {
				return nil, e
			}
			last = time.Now()
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	after, e := file.Stat()
	if e != nil {
		return nil, e
	}
	if size != info.Size() || !os.SameFile(info, after) || !info.ModTime().Equal(after.ModTime()) || info.Size() != after.Size() {
		return nil, forbidden("official base changed while hashing")
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	return map[string]any{"name": name, "sizeBytes": size, "sha256": digest, "verified": digest == m.Base.SHA256}, nil
}

// layerRelease can run after VM registration, but can remove only its proven staging generation.
func (s *Server) layerRelease(_ context.Context, raw json.RawMessage) (any, error) {
	a, _, e := s.layerRequest(raw, true)
	if e != nil {
		return nil, e
	}
	jobs := filepath.Join(s.Cfg.StateDir, "layer-jobs")
	if e = layerDirectory(jobs); e != nil {
		return nil, e
	}
	lock, e := os.OpenFile(filepath.Join(jobs, "cache.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600) //nolint:gosec // fixed lock in root-owned state directory
	if e != nil {
		return nil, e
	}
	defer func() { _ = lock.Close() }()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return nil, ErrBusy
	}
	name := "umiak-layer-" + a.JobID + ".raw"
	media := filepath.Join(s.Cfg.ImportDir, name)
	marker := filepath.Join(jobs, a.JobID+".json")
	data, e := readLayerReceipt(marker)
	if os.IsNotExist(e) {
		if _, e = os.Lstat(media); os.IsNotExist(e) {
			return map[string]any{"released": false, "missing": true}, nil
		}
		return nil, forbidden("layer media has no ownership receipt")
	}
	if e != nil {
		return nil, e
	}
	digest := sha256.Sum256(a.Manifest)
	var receipt layerReceipt
	if json.Unmarshal(data, &receipt) != nil || receipt.JobID != a.JobID || receipt.VMID != a.VMID || receipt.ManifestSHA256 != hex.EncodeToString(digest[:]) || receipt.MediaName != name {
		return nil, forbidden("layer release identity collision")
	}
	if receipt.TempName != "" {
		if !regexp.MustCompile(`^\.umiak-layer-` + a.JobID + `-[0-9]+$`).MatchString(receipt.TempName) {
			return nil, forbidden("invalid pending layer media name")
		}
		if e = removeOwnedLayerMedia(filepath.Join(s.Cfg.ImportDir, receipt.TempName), receipt.MediaIdentity); e != nil {
			return nil, e
		}
	}
	if e = removeOwnedLayerMedia(media, receipt.MediaIdentity); e != nil {
		return nil, e
	}
	if e = os.Remove(marker); e != nil {
		return nil, e
	}
	return map[string]any{"released": true}, nil
}

// The global cache lock is held by the caller. Old VM builds use their imported
// media, so chunks outside this manifest may be evicted independently of VM life.
func pruneLayerCache(cache string, m layerManifest, budget int64) error {
	type entry struct {
		path string
		info os.FileInfo
	}
	needed := map[string]bool{}
	var missing int64
	for _, c := range m.Archive.Chunks {
		needed[c.SHA256] = true
		ok, e := layerFileVerified(filepath.Join(cache, c.SHA256), c)
		if e != nil {
			return e
		}
		if !ok {
			missing += c.SizeBytes
		}
	}
	entries, e := os.ReadDir(cache)
	if e != nil {
		return e
	}
	var used int64
	var candidates []entry
	for _, item := range entries {
		info, e := item.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return errors.New("nonregular layer cache entry")
		}
		used += info.Size()
		if !needed[item.Name()] && layerDigestRE.MatchString(item.Name()) {
			candidates = append(candidates, entry{path: filepath.Join(cache, item.Name()), info: info})
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].info.ModTime().Before(candidates[j].info.ModTime()) })
	for _, candidate := range candidates {
		if used+missing <= budget {
			return nil
		}
		ok, e := layerFileVerified(candidate.path, layerBlob{SHA256: filepath.Base(candidate.path), SizeBytes: candidate.info.Size()})
		if e != nil {
			return e
		}
		if !ok {
			continue
		}
		current, e := os.Lstat(candidate.path)
		if e != nil {
			return e
		}
		if !os.SameFile(candidate.info, current) {
			return forbidden("layer cache generation changed during eviction")
		}
		if e = os.Remove(candidate.path); e != nil {
			return e
		}
		used -= candidate.info.Size()
	}
	if used+missing > budget {
		return errors.New("layer cache quota exceeded; unproved partials or oversized layer need operator attention")
	}
	return nil
}
