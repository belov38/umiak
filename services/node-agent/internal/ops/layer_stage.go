package ops

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

//go:embed recipe-publisher.pub
var layerPublisherKey string

const defaultLayerBaseURL = "https://pub-bdc85570347b44df991bfcee2718c4a1.r2.dev"

type layerRequest struct {
	JobID     string          `json:"jobId"`
	VMID      int             `json:"vmid"`
	Manifest  json.RawMessage `json:"manifest"`
	Signature []byte          `json:"signature"`
	Platform  string          `json:"platform"`
	Agent     string          `json:"agent"`
	Channel   string          `json:"channel"`
	Slug      string          `json:"slug"`
}
type layerReceipt struct {
	TempName       string `json:"tempName,omitempty"`
	JobID          string `json:"jobId"`
	VMID           int    `json:"vmid"`
	ManifestSHA256 string `json:"manifestSha256"`
	MediaName      string `json:"mediaName"`
	MediaIdentity  string `json:"mediaIdentity"`
	MediaSHA256    string `json:"mediaSha256"`
	MediaBytes     int64  `json:"mediaBytes"`
	Verified       bool   `json:"verified"`
}

func (s *Server) layerRequest(raw json.RawMessage) (layerRequest, layerManifest, error) {
	var a layerRequest
	var m layerManifest
	if e := decodeArgs(raw, &a); e != nil {
		return a, m, e
	}
	if !regexp.MustCompile(`^[a-f0-9]{24}$`).MatchString(a.JobID) || !s.Cfg.IsTemplateSlot(a.VMID) || a.VMID == 590 {
		return a, m, forbidden("invalid layer job or template VMID")
	}
	keys := []string{layerPublisherKey}
	if s.Cfg.LayerKeysFile != "" {
		data, e := os.ReadFile(s.Cfg.LayerKeysFile)
		if e != nil {
			return a, m, e
		}
		if strings.HasPrefix(strings.TrimSpace(string(data)), "[") {
			if e = json.Unmarshal(data, &keys); e != nil {
				return a, m, e
			}
		} else {
			keys = []string{string(data)}
		}
	}
	m, e := verifyLayerManifest(a.Manifest, a.Signature, keys, a.Platform, a.Agent, a.Channel, a.Slug)
	if e != nil {
		return a, m, e
	}
	if _, e = fs.ReadFile(s.Host.FS, fmt.Sprintf("etc/pve/qemu-server/%d.conf", a.VMID)); e == nil {
		return a, m, forbidden("layer target VMID is occupied")
	} else if !errors.Is(e, fs.ErrNotExist) {
		return a, m, e
	}
	return a, m, nil
}
func layerDirectory(path string) error {
	if e := os.MkdirAll(path, 0700); e != nil {
		return e
	}
	info, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("layer state path is not a real directory")
	}
	return nil
}
func (s *Server) layerPrepare(_ context.Context, raw json.RawMessage) (any, error) {
	a, m, e := s.layerRequest(raw)
	if e != nil {
		return nil, e
	}
	cache := filepath.Join(s.Cfg.StateDir, "layer-cache")
	if e = layerDirectory(cache); e != nil {
		return nil, e
	}
	missing := []string{}
	for _, c := range m.Archive.Chunks {
		ok, e := layerFileVerified(filepath.Join(cache, c.SHA256), c)
		if e != nil {
			return nil, e
		}
		if !ok {
			missing = append(missing, c.SHA256)
		}
	}
	sum := sha256.Sum256(a.Manifest)
	return map[string]any{"missing": missing, "manifestSha256": hex.EncodeToString(sum[:])}, nil
}
func fileIdentity(info fs.FileInfo) (string, error) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", errors.New("layer media filesystem identity unavailable")
	}
	return fmt.Sprintf("%d:%d", st.Dev, st.Ino), nil
}
func durableLayerReceipt(path string, r layerReceipt) error {
	data, e := json.Marshal(r)
	if e != nil {
		return e
	}
	if info, err := os.Lstat(path + ".new"); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("nonregular layer receipt temporary file")
		}
		if err = os.Remove(path + ".new"); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	file, e := os.OpenFile(path+".new", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600) //nolint:gosec // fixed receipt suffix in root-owned state directory
	if e != nil {
		return e
	}
	defer func() { _ = file.Close(); _ = os.Remove(path + ".new") }()
	if _, e = file.Write(data); e != nil {
		return e
	}
	if e = file.Sync(); e != nil {
		return e
	}
	if e = file.Close(); e != nil {
		return e
	}
	if e = os.Rename(path+".new", path); e != nil {
		return e
	}
	dir, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}
func (s *Server) layerStage(ctx context.Context, raw json.RawMessage) (any, error) {
	a, m, e := s.layerRequest(raw)
	if e != nil {
		return nil, e
	}
	cache := filepath.Join(s.Cfg.StateDir, "layer-cache")
	jobs := filepath.Join(s.Cfg.StateDir, "layer-jobs")
	for _, dir := range []string{cache, jobs, s.Cfg.ImportDir} {
		if e = layerDirectory(dir); e != nil {
			return nil, e
		}
	}
	cacheLock, e := os.OpenFile(filepath.Join(jobs, "cache.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600) //nolint:gosec // fixed lock name in root-owned state directory
	if e != nil {
		return nil, e
	}
	defer func() { _ = cacheLock.Close() }()
	if e = syscall.Flock(int(cacheLock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return nil, ErrBusy
	}
	lock, e := os.OpenFile(filepath.Join(jobs, strconv.Itoa(a.VMID)+".lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600) //nolint:gosec // validated template VMID in root-owned lock directory
	if e != nil {
		return nil, e
	}
	defer func() { _ = lock.Close() }()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return nil, ErrBusy
	}
	digest := sha256.Sum256(a.Manifest)
	receipt := layerReceipt{JobID: a.JobID, VMID: a.VMID, ManifestSHA256: hex.EncodeToString(digest[:]), MediaName: "umiak-layer-" + a.JobID + ".raw"}
	media := filepath.Join(s.Cfg.ImportDir, receipt.MediaName)
	marker := filepath.Join(jobs, a.JobID+".json")
	var previous layerReceipt
	if data, err := readLayerReceipt(marker); err == nil {
		if json.Unmarshal(data, &previous) != nil || previous.JobID != receipt.JobID || previous.VMID != a.VMID || previous.ManifestSHA256 != receipt.ManifestSHA256 || previous.MediaName != receipt.MediaName {
			return nil, forbidden("layer receipt identity collision")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if previous.TempName != "" {
		if !regexp.MustCompile(`^\.umiak-layer-` + a.JobID + `-[0-9]+$`).MatchString(previous.TempName) {
			return nil, forbidden("invalid pending layer media name")
		}
		if e = removeOwnedLayerMedia(filepath.Join(s.Cfg.ImportDir, previous.TempName), previous.MediaIdentity); e != nil {
			return nil, e
		}
	}
	if info, err := os.Lstat(media); err == nil {
		identity, e := fileIdentity(info)
		if e != nil {
			return nil, e
		}
		if !info.Mode().IsRegular() || identity != previous.MediaIdentity {
			return nil, forbidden("existing layer media ownership cannot be proved")
		}
		if previous.Verified {
			ok, e := layerFileVerified(media, layerBlob{SHA256: previous.MediaSHA256, SizeBytes: previous.MediaBytes})
			if e != nil {
				return nil, e
			}
			if !ok {
				return nil, forbidden("completed layer media changed")
			}
			return previous, nil
		}
		if e = os.Remove(media); e != nil {
			return nil, e
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	budget := s.Cfg.LayerCacheBytes
	if budget == 0 {
		budget = 16 << 30
	}
	entries, e := os.ReadDir(cache)
	if e != nil {
		return nil, e
	}
	var used int64
	for _, entry := range entries {
		info, e := entry.Info()
		if e != nil {
			return nil, e
		}
		if !info.Mode().IsRegular() || info.Size() > budget-used {
			return nil, errors.New("layer cache quota exceeded or nonregular entry")
		}
		used += info.Size()
	}
	var missing int64
	for _, c := range m.Archive.Chunks {
		valid, e := layerFileVerified(filepath.Join(cache, c.SHA256), c)
		if e != nil {
			return nil, e
		}
		if !valid {
			missing += c.SizeBytes
		}
	}
	if missing > budget-used {
		return nil, errors.New("layer cache quota exceeded; retire unused cached layers")
	}
	var stat syscall.Statfs_t
	if e = syscall.Statfs(s.Cfg.ImportDir, &stat); e != nil {
		return nil, e
	}
	if float64(stat.Bavail)*float64(stat.Bsize) < float64(missing+3*m.Archive.SizeBytes+64<<20) {
		return nil, errors.New("insufficient layer staging disk space")
	}
	// The stdio channel closing cancels downloads/formatting within a heartbeat.
	// Partial owned media has a durable inode marker and is safe to retry.
	ctx, cancel := context.WithTimeout(ctx, 4*time.Hour)
	var completed atomic.Int64
	stopped := make(chan struct{})
	started := time.Now()
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if s.Progress != nil {
					if err := s.Progress(map[string]any{"completedChunks": completed.Load(), "elapsedSeconds": int64(time.Since(started).Seconds())}); err != nil {
						cancel()
						return
					}
				}
			}
		}
	}()
	defer func() { cancel(); <-stopped }()
	base := s.Cfg.LayerBaseURL
	if base == "" {
		base = defaultLayerBaseURL
	}
	client := s.LayerHTTP
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Minute}
	}
	paths := make([]string, 0, len(m.Archive.Chunks))
	for _, c := range m.Archive.Chunks {
		p, e := downloadLayerBlob(ctx, client, base, cache, c, nil)
		if e != nil {
			return nil, e
		}
		paths = append(paths, p)
		completed.Add(1)
	}
	stage, e := prepareLayerExtraction(jobs, a, receipt.ManifestSHA256)
	if e != nil {
		return nil, e
	}
	defer func() { _ = os.RemoveAll(stage) }()
	members := filepath.Join(stage, "members")
	if e = decodeLayer(ctx, paths, m, members); e != nil {
		return nil, e
	}
	var bytes int64
	for _, f := range m.Files {
		bytes += f.SizeBytes
	}
	receipt.MediaBytes = max(64<<20, ((bytes+bytes/4+32<<20)+(1<<20)-1)/(1<<20)*(1<<20))
	file, e := os.CreateTemp(s.Cfg.ImportDir, ".umiak-layer-"+a.JobID+"-")
	if e != nil {
		return nil, e
	}
	tempPath := file.Name()
	defer func() { _ = os.Remove(tempPath) }()
	info, e := file.Stat()
	if e != nil {
		_ = file.Close()
		return nil, e
	}
	receipt.MediaIdentity, e = fileIdentity(info)
	if e != nil {
		_ = file.Close()
		return nil, e
	}
	receipt.TempName = filepath.Base(tempPath)
	if e = durableLayerReceipt(marker, receipt); e != nil {
		_ = file.Close()
		return nil, e
	}
	if e = os.Link(tempPath, media); e != nil {
		_ = file.Close()
		return nil, e
	}
	if e = os.Remove(tempPath); e != nil {
		_ = file.Close()
		return nil, e
	}
	receipt.TempName = ""

	if e = file.Truncate(receipt.MediaBytes); e != nil {
		_ = file.Close()
		return nil, e
	}
	_ = file.Close()
	if _, e = s.Host.Run(ctx, "mke2fs", "-q", "-t", "ext4", "-F", "-L", "umiak-layer", "-d", members, media); e != nil {
		return nil, e
	}
	file, e = os.OpenFile(media, os.O_RDWR|syscall.O_NOFOLLOW, 0) //nolint:gosec // job-owned inode is checked against durable receipt
	if e != nil {
		return nil, e
	}
	defer func() { _ = file.Close() }()
	currentInfo, e := file.Stat()
	if e != nil {
		return nil, e
	}
	identity, e := fileIdentity(currentInfo)
	if e != nil || identity != receipt.MediaIdentity {
		return nil, forbidden("layer media generation changed during creation")
	}
	magic := make([]byte, 2)
	if _, e = file.ReadAt(magic, 1080); e != nil || magic[0] != 0x53 || magic[1] != 0xef {
		return nil, errors.New("layer media is not an ext4 filesystem")
	}
	if e = file.Sync(); e != nil {
		return nil, e
	}
	if _, e = file.Seek(0, io.SeekStart); e != nil {
		return nil, e
	}
	hash := sha256.New()
	if _, e = io.Copy(hash, file); e != nil {
		return nil, e
	}
	receipt.MediaSHA256 = hex.EncodeToString(hash.Sum(nil))
	receipt.Verified = true
	if e = durableLayerReceipt(marker, receipt); e != nil {
		return nil, e
	}
	return receipt, nil
}
func decodeLayer(ctx context.Context, paths []string, m layerManifest, directory string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	files := []*os.File{}
	defer func() {
		for _, f := range files {
			_ = f.Close()
		}
	}()
	readers := []io.Reader{}
	for _, p := range paths {
		f, e := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0) //nolint:gosec // validated digest cache paths produced by verified downloads
		if e != nil {
			return e
		}
		files = append(files, f)
		readers = append(readers, f)
	}
	hash := sha256.New()
	command := exec.CommandContext(ctx, "zstd", "-d", "-q", "-c")
	command.Stdin = io.TeeReader(io.MultiReader(readers...), hash)
	command.WaitDelay = 5 * time.Second
	var log boundedLog
	command.Stderr = &log
	decoded, e := command.StdoutPipe()
	if e != nil {
		return e
	}
	if e = command.Start(); e != nil {
		return e
	}
	extractErr := extractLayerTar(decoded, m, directory)
	if extractErr != nil {
		cancel()
	}
	processErr := command.Wait()
	if extractErr != nil {
		return extractErr
	}
	if processErr != nil {
		return errors.New("offline layer zstd decoding failed")
	}
	if hex.EncodeToString(hash.Sum(nil)) != m.Archive.SHA256 {
		return errors.New("compressed layer hash mismatch")
	}
	return nil
}

func readLayerReceipt(path string) ([]byte, error) {
	f, e := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0) //nolint:gosec // job-derived receipt in root-owned state; symlinks refused
	if e != nil {
		return nil, e
	}
	defer func() { _ = f.Close() }()
	info, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Size() > 8192 {
		return nil, errors.New("invalid layer receipt file")
	}
	return io.ReadAll(io.LimitReader(f, 8192))
}

func removeOwnedLayerMedia(path, identity string) error {
	info, e := os.Lstat(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	id, e := fileIdentity(info)
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() || id != identity {
		return forbidden("pending layer media generation changed")
	}
	return os.Remove(path)
}

func prepareLayerExtraction(jobs string, a layerRequest, digest string) (string, error) {
	stage := filepath.Join(jobs, a.JobID+".extract")
	if info, e := os.Lstat(stage); e == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", forbidden("non-directory layer extraction state")
		}
		data, err := readLayerReceipt(filepath.Join(stage, ".owner.json"))
		if os.IsNotExist(err) {
			data, err = readLayerReceipt(filepath.Join(stage, ".owner.json.new"))
		}
		if os.IsNotExist(err) {
			entries, e := os.ReadDir(stage)
			if e != nil {
				return "", e
			}
			if len(entries) != 0 {
				return "", forbidden("unproved layer extraction ownership")
			}
			if e = os.Remove(stage); e != nil {
				return "", e
			}
		} else {
			var owner layerReceipt
			if err != nil || json.Unmarshal(data, &owner) != nil || owner.JobID != a.JobID || owner.VMID != a.VMID || owner.ManifestSHA256 != digest {
				return "", forbidden("layer extraction identity collision")
			}
			if e = os.RemoveAll(stage); e != nil {
				return "", e
			}
		}
	} else if !os.IsNotExist(e) {
		return "", e
	}
	if e := os.Mkdir(stage, 0700); e != nil {
		return "", e
	}
	if e := durableLayerReceipt(filepath.Join(stage, ".owner.json"), layerReceipt{JobID: a.JobID, VMID: a.VMID, ManifestSHA256: digest}); e != nil {
		return "", e
	}
	if e := os.Mkdir(filepath.Join(stage, "members"), 0700); e != nil {
		return "", e
	}
	return stage, nil
}
