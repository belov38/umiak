package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func layerObjectURL(base, key string) (string, error) {
	u, e := url.Parse(base)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" {
		return "", errors.New("layer origin must be configured HTTPS")
	}
	if !layerDigestRE.MatchString(key) {
		return "", errors.New("invalid layer digest")
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/blobs/sha256/" + key
	return u.String(), nil
}
func layerFileVerified(path string, blob layerBlob) (bool, error) {
	info, e := os.Lstat(path)
	if os.IsNotExist(e) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if !info.Mode().IsRegular() {
		return false, errors.New("layer cache entry is not a regular file")
	}
	if info.Size() != blob.SizeBytes {
		return false, nil
	}
	f, e := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0) //nolint:gosec // validated digest in root-owned cache; refuse symlinks
	if e != nil {
		return false, e
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, e := io.Copy(h, io.LimitReader(f, blob.SizeBytes+1))
	return e == nil && n == blob.SizeBytes && hex.EncodeToString(h.Sum(nil)) == blob.SHA256, e
}
func layerRetry(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// downloadLayerBlob resumes at verified chunk boundaries without requiring Range support.
func downloadLayerBlob(ctx context.Context, client *http.Client, base, directory string, blob layerBlob, wait func(context.Context, time.Duration) error) (string, error) {
	if blob.SizeBytes < 1 || blob.SizeBytes > layerMaxChunk || !layerDigestRE.MatchString(blob.SHA256) {
		return "", badReq("invalid layer chunk")
	}
	remote, e := layerObjectURL(base, blob.SHA256)
	if e != nil {
		return "", e
	}
	path := filepath.Join(directory, blob.SHA256)
	valid, e := layerFileVerified(path, blob)
	if e != nil {
		return "", e
	}
	if valid {
		return path, nil
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Minute}
	}
	copyClient := *client
	origin, _ := url.Parse(remote)
	copyClient.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if r.URL.Scheme != "https" || r.URL.Host != origin.Host || len(via) >= 5 {
			return errors.New("layer redirect outside configured origin")
		}
		return nil
	}
	if wait == nil {
		wait = layerRetry
	}
	var last error
	for attempt := 0; attempt < 5; attempt++ {
		if e = ctx.Err(); e != nil {
			return "", e
		}
		delay := time.Duration(attempt+1) * time.Second
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, remote, nil)
		if err != nil {
			return "", err
		}
		response, err := copyClient.Do(request)
		if err != nil {
			last = errors.New("layer chunk request failed")
		} else {
			if response.StatusCode == http.StatusOK {
				last = saveLayerChunk(response.Body, response.ContentLength, directory, path, blob)
				_ = response.Body.Close()
				if last == nil {
					return path, nil
				}
			} else {
				last = fmt.Errorf("layer chunk HTTP %d", response.StatusCode)
				_ = response.Body.Close()
				if seconds, e := strconv.Atoi(response.Header.Get("Retry-After")); e == nil && seconds > 0 {
					delay = min(time.Duration(seconds), 60) * time.Second
				}
			}
		}
		if attempt < 4 {
			if e = wait(ctx, delay); e != nil {
				return "", e
			}
		}
	}
	return "", fmt.Errorf("layer chunk %s failed after five attempts: %w", blob.SHA256, last)
}
func saveLayerChunk(body io.Reader, length int64, directory, destination string, blob layerBlob) error {
	if length >= 0 && length != blob.SizeBytes {
		return errors.New("layer chunk Content-Length mismatch")
	}
	part, e := os.CreateTemp(directory, ".incoming-")
	if e != nil {
		return e
	}
	defer func() { _ = part.Close(); _ = os.Remove(part.Name()) }()
	h := sha256.New()
	n, e := io.Copy(io.MultiWriter(part, h), io.LimitReader(body, blob.SizeBytes+1))
	if e != nil {
		return e
	}
	if n != blob.SizeBytes || hex.EncodeToString(h.Sum(nil)) != blob.SHA256 {
		return errors.New("layer chunk size/hash mismatch")
	}
	if e = part.Sync(); e != nil {
		return e
	}
	if e = part.Close(); e != nil {
		return e
	}
	if e = os.Rename(part.Name(), destination); e != nil {
		return e
	}
	dir, e := os.Open(directory) //nolint:gosec // root-owned configured cache directory
	if e != nil {
		return e
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}
