package update

import (
	"archive/tar"
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// maxUnpackBytes caps the total size of the regular files of a package.
const maxUnpackBytes = 512 << 20

// PackOptions describes a package to build.
type PackOptions struct {
	// Version, OS and Arch go into the manifest.
	Version, OS, Arch string
	// Binary, TunnelCA and UpdateKeys are the paths of the files packed as
	// sbx-agent, trust/tunnel-ca.pem and trust/update-keys.pub.
	Binary, TunnelCA, UpdateKeys string
	// Key signs manifest.json.
	Key ed25519.PrivateKey
	// Out is the tar file to write.
	Out string
	// Now is CreatedAt; zero means time.Now.
	Now time.Time
}

// packFile is one regular file of a package being built.
type packFile struct {
	name string
	mode int64
	data []byte
}

// Pack builds a signed package (spec 17.1): a plain tar with sbx-agent,
// trust/, manifest.json and manifest.sig. The tar is written atomically.
func Pack(o PackOptions) (*Manifest, error) {
	if err := ValidVersion(o.Version); err != nil {
		return nil, err
	}
	if o.OS == "" || o.Arch == "" {
		return nil, errors.New("update: pack: os and arch are required")
	}
	if len(o.Key) != ed25519.PrivateKeySize {
		return nil, errors.New("update: pack: signing key is required")
	}
	created := o.Now
	if created.IsZero() {
		created = time.Now()
	}
	created = created.UTC().Truncate(time.Second)

	var files []packFile
	for _, f := range []struct {
		name, src string
		mode      int64
	}{
		{BinaryName, o.Binary, 0o755},
		{TunnelCAName, o.TunnelCA, 0o644},
		{UpdateKeysName, o.UpdateKeys, 0o644},
	} {
		if f.src == "" {
			return nil, fmt.Errorf("update: pack: no source for %s", f.name)
		}
		data, err := os.ReadFile(f.src)
		if err != nil {
			return nil, fmt.Errorf("update: pack: %w", err)
		}
		files = append(files, packFile{name: f.name, mode: f.mode, data: data})
	}

	m := &Manifest{
		Format:    ManifestFormat,
		Version:   o.Version,
		OS:        o.OS,
		Arch:      o.Arch,
		Files:     make(map[string]string, len(files)),
		CreatedAt: created,
	}
	for _, f := range files {
		sum := sha256.Sum256(f.data)
		m.Files[f.name] = hex.EncodeToString(sum[:])
	}
	mbytes, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	mbytes = append(mbytes, '\n')
	sig := ed25519.Sign(o.Key, mbytes)
	files = append(files,
		packFile{name: ManifestName, mode: 0o644, data: mbytes},
		packFile{name: SignatureName, mode: 0o644, data: sig},
	)

	if err := writeTar(o.Out, created, files); err != nil {
		return nil, fmt.Errorf("update: pack: %w", err)
	}
	return m, nil
}

// writeTar writes files (and the trust/ directory) to out through a
// temporary file.
func writeTar(out string, mtime time.Time, files []packFile) (err error) {
	tmp, err := os.CreateTemp(filepath.Dir(out), "."+filepath.Base(out)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	tw := tar.NewWriter(tmp)
	if err = tw.WriteHeader(&tar.Header{Name: TrustDir + "/", Typeflag: tar.TypeDir, Mode: 0o755, ModTime: mtime}); err != nil {
		return err
	}
	for _, f := range files {
		hdr := &tar.Header{Name: f.name, Typeflag: tar.TypeReg, Mode: f.mode, Size: int64(len(f.data)), ModTime: mtime}
		if err = tw.WriteHeader(hdr); err != nil {
			return err
		}
		if _, err = tw.Write(f.data); err != nil {
			return err
		}
	}
	if err = tw.Close(); err != nil {
		return err
	}
	if err = tmp.Chmod(0o644); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), out)
}

// invalidPackage is the error of a malformed package.
func invalidPackage(format string, args ...any) *connect.Error {
	return errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, "update: "+format, args...)
}

// signatureInvalid is the error of a package whose signature or content
// does not verify.
func signatureInvalid(format string, args ...any) *connect.Error {
	return errs.Newf(connect.CodeInvalidArgument, errs.SignatureInvalid, "update: "+format, args...)
}

// entryName validates a slash-separated package entry name and returns it
// cleaned. ok is false for the archive root ("." or "./").
func entryName(raw string) (name string, ok bool, err error) {
	if raw == "" || strings.HasPrefix(raw, "/") || strings.ContainsAny(raw, "\\\x00") {
		return "", false, invalidPackage("bad entry name %q", raw)
	}
	for _, elem := range strings.Split(raw, "/") {
		if elem == ".." {
			return "", false, invalidPackage("entry %q leaves the package", raw)
		}
	}
	name = path.Clean(raw)
	if name == "." {
		return "", false, nil
	}
	return name, true, nil
}

// Unpack extracts the tar at tarPath into dst (created if needed). Only
// regular files and directories are accepted, every name must stay inside
// dst, an entry may appear once, and the regular files may total at most
// 512 MiB. Format violations are invalid_argument errors; dst may hold a
// partial tree on error and is the caller's to remove.
func Unpack(tarPath, dst string) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	tr := tar.NewReader(bufio.NewReader(f))
	var total int64
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return invalidPackage("read package: %v", err)
		}
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		name, ok, err := entryName(hdr.Name)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		target := filepath.Join(dst, filepath.FromSlash(name))
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if hdr.Size < 0 || hdr.Size > maxUnpackBytes-total {
				return invalidPackage("package is larger than %d bytes", maxUnpackBytes)
			}
			total += hdr.Size
			if err := extractFile(tr, target, hdr); err != nil {
				return err
			}
		default:
			return invalidPackage("entry %q has unsupported type %q", hdr.Name, hdr.Typeflag)
		}
	}
}

// extractFile writes one regular file. O_EXCL rejects duplicates.
func extractFile(r io.Reader, target string, hdr *tar.Header) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	perm := fs.FileMode(0o644)
	if hdr.Mode&0o111 != 0 {
		perm = 0o755
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if errors.Is(err, fs.ErrExist) {
		return invalidPackage("duplicate entry %q", hdr.Name)
	}
	if err != nil {
		return err
	}
	if _, err := io.CopyN(out, r, hdr.Size); err != nil {
		_ = out.Close()
		return invalidPackage("read %q: %v", hdr.Name, err)
	}
	return out.Close()
}

// Verify checks an unpacked package in dir against keys: the signature over
// the exact bytes of manifest.json, the manifest fields, the sha256 of every
// listed file, no missing and no unlisted files (manifest.sig aside) and no
// entries other than regular files and directories. Signature and content
// mismatches are signature_invalid; a malformed manifest is
// invalid_argument.
func Verify(dir string, keys []ed25519.PublicKey) (*Manifest, error) {
	mbytes, err := readRegular(filepath.Join(dir, ManifestName))
	if err != nil {
		return nil, signatureInvalid("manifest: %v", err)
	}
	sig, err := readRegular(filepath.Join(dir, SignatureName))
	if err != nil {
		return nil, signatureInvalid("signature: %v", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return nil, signatureInvalid("signature is %d bytes, want %d", len(sig), ed25519.SignatureSize)
	}
	if !slices.ContainsFunc(keys, func(k ed25519.PublicKey) bool {
		return len(k) == ed25519.PublicKeySize && ed25519.Verify(k, mbytes, sig)
	}) {
		return nil, signatureInvalid("manifest signature matches no trusted key")
	}

	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(mbytes))
	if err := dec.Decode(&m); err != nil {
		return nil, invalidPackage("parse manifest: %v", err)
	}
	if err := checkManifest(&m); err != nil {
		return nil, err
	}

	seen := make(map[string]bool, len(m.Files))
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		switch {
		case d.IsDir():
			return nil
		case !d.Type().IsRegular():
			return signatureInvalid("entry %q is not a regular file", rel)
		case rel == ManifestName || rel == SignatureName:
			return nil
		}
		want, ok := m.Files[rel]
		if !ok {
			return signatureInvalid("file %q is not in the manifest", rel)
		}
		got, err := fileSHA256(p)
		if err != nil {
			return err
		}
		if got != want {
			return signatureInvalid("file %q does not match its sha256", rel)
		}
		seen[rel] = true
		return nil
	})
	if err != nil {
		var cerr *connect.Error
		if errors.As(err, &cerr) {
			return nil, cerr
		}
		return nil, fmt.Errorf("update: verify: %w", err)
	}
	for name := range m.Files {
		if !seen[name] {
			return nil, signatureInvalid("file %q is missing", name)
		}
	}
	return &m, nil
}

// checkManifest validates the fields of a signed manifest.
func checkManifest(m *Manifest) error {
	if m.Format != ManifestFormat {
		return invalidPackage("manifest format %q, want %q", m.Format, ManifestFormat)
	}
	if err := ValidVersion(m.Version); err != nil {
		return invalidPackage("%v", err)
	}
	if m.OS == "" || m.Arch == "" {
		return invalidPackage("manifest has no os or arch")
	}
	for name, sum := range m.Files {
		clean, ok, err := entryName(name)
		if err != nil || !ok || clean != name || name == ManifestName || name == SignatureName {
			return invalidPackage("manifest lists bad file name %q", name)
		}
		if len(sum) != 2*sha256.Size {
			return invalidPackage("manifest has a bad sha256 for %q", name)
		}
	}
	for _, name := range requiredFiles {
		if _, ok := m.Files[name]; !ok {
			return invalidPackage("manifest does not list %s", name)
		}
	}
	return nil
}

// readRegular reads a file that must be a regular file (not a symlink).
func readRegular(p string) ([]byte, error) {
	fi, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", filepath.Base(p))
	}
	return os.ReadFile(p)
}

// fileSHA256 returns the lowercase hex sha256 of a file.
func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
