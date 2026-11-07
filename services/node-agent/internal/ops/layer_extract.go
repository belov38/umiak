package ops

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
)

// extractLayerTar writes only regular inventoried files beneath a new owned root.
// The caller verifies publisher metadata before passing the archive here.
func extractLayerTar(input io.Reader, m layerManifest, directory string) error {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	hash := sha256.New()
	limited := &io.LimitedReader{R: input, N: m.Archive.SizeBytes + 1}
	reader := io.TeeReader(limited, hash)
	archive := tar.NewReader(reader)
	expected := map[string]layerFile{}
	seen := map[string]bool{}
	for _, f := range m.Files {
		expected[f.Path] = f
	}
	entries := 0
	for {
		header, e := archive.Next()
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			return e
		}
		entries++
		if entries > 16384 {
			return errors.New("layer archive has too many entries")
		}
		name := strings.TrimSuffix(header.Name, "/")
		if header.Typeflag == tar.TypeDir {
			if !layerPathValid(name+"/directory") || seen[name+"/"] {
				return errors.New("invalid layer directory")
			}
			seen[name+"/"] = true
			if e = root.MkdirAll(name, 0700); e != nil {
				return e
			}
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return errors.New("layer archive links and special files forbidden")
		}
		f, ok := expected[name]
		if !ok || !layerPathValid(name) || seen[name] || header.Size != f.SizeBytes || header.Mode != f.Mode {
			return errors.New("layer member differs from signed inventory")
		}
		seen[name] = true
		if e = root.MkdirAll(path.Dir(name), 0700); e != nil {
			return e
		}
		out, e := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(archive, f.SizeBytes+1))
		syncErr := out.Sync()
		closeErr := out.Close()
		if copyErr != nil || syncErr != nil || closeErr != nil {
			return errors.Join(copyErr, syncErr, closeErr)
		}
		if n != f.SizeBytes || hex.EncodeToString(h.Sum(nil)) != f.SHA256 {
			return errors.New("layer file hash mismatch")
		}
		mode := os.FileMode(0644)
		if f.Mode == 0755 {
			mode = 0755
		}
		if e = root.Chmod(name, mode); e != nil {
			return e
		}
	}
	// tar EOF may leave block padding. All trailing bytes must be zero, and the
	// complete uncompressed archive (including padding) is size/hash authenticated.
	buf := make([]byte, 64<<10)
	for {
		n, e := reader.Read(buf)
		for _, b := range buf[:n] {
			if b != 0 {
				return errors.New("nonzero data after layer archive")
			}
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
	}
	if limited.N != 1 || hex.EncodeToString(hash.Sum(nil)) != m.Archive.RawSHA256 {
		return errors.New("layer archive size/hash mismatch")
	}
	for _, f := range m.Files {
		if !seen[f.Path] {
			return fmt.Errorf("missing layer file %s", f.Path)
		}
	}
	// Directories are created private while untrusted bytes stream in (the
	// staging parent stays 0700). The guest reads the media as _apt (gpgv
	// sandbox) and other users, so publish every directory as 0755.
	return fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, e error) error {
		if e != nil || !d.IsDir() {
			return e
		}
		return root.Chmod(name, 0755)
	})
}
