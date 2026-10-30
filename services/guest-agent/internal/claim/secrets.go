package claim

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// Secret limits (spec 8.1).
const (
	MaxSecretFileBytes  = 1 << 20
	MaxSecretFilesBytes = 8 << 20
	// DefaultSecretFileMode applies to a secret file without a mode.
	DefaultSecretFileMode = 0o440
)

// ErrSecretInUse reports a secret file held open by another process without
// sharing write and delete access, so it cannot be wiped (Windows).
var ErrSecretInUse = errors.New("claim: secret file is in use")

// secretFileName is a valid secret file name; "." and ".." are refused
// separately.
var secretFileName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// SecretsDigest returns the hex sha256 of a canonical encoding of the secret
// set: env sorted by key, files sorted by name, every field length-prefixed.
// File modes are taken as given; callers normalize them first. An empty set
// has the empty digest.
func SecretsDigest(env map[string]string, files []*agentv1.SecretFile) string {
	if len(env) == 0 && len(files) == 0 {
		return ""
	}
	h := sha256.New()
	h.Write([]byte("sbx-secrets-v1"))
	writeU64(h, uint64(len(env)))
	for _, k := range slices.Sorted(maps.Keys(env)) {
		writeField(h, []byte(k))
		writeField(h, []byte(env[k]))
	}
	sorted := slices.Clone(files)
	slices.SortFunc(sorted, func(a, b *agentv1.SecretFile) int { return strings.Compare(a.GetName(), b.GetName()) })
	writeU64(h, uint64(len(sorted)))
	for _, f := range sorted {
		writeField(h, []byte(f.GetName()))
		writeField(h, f.GetContent())
		writeU64(h, uint64(f.GetMode()))
		writeField(h, []byte(f.GetLinkPath()))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func writeU64(h hash.Hash, v uint64) {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], v)
	h.Write(b[:])
}

func writeField(h hash.Hash, b []byte) {
	writeU64(h, uint64(len(b)))
	h.Write(b)
}

// validateSecrets checks the secret env and files against the limits of
// spec 8.1.
func validateSecrets(env map[string]string, files []*agentv1.SecretFile) error {
	if err := validateEnv("secret_env", env); err != nil {
		return err
	}
	var total int
	seen := make(map[string]bool, len(files))
	for _, f := range files {
		name := f.GetName()
		if !secretFileName.MatchString(name) || name == "." || name == ".." {
			return invalid("secret_files: invalid name")
		}
		if seen[name] {
			return invalid("secret_files: duplicate name " + name)
		}
		seen[name] = true
		if len(f.GetContent()) > MaxSecretFileBytes {
			return invalid("secret_files: " + name + " is larger than 1 MiB")
		}
		total += len(f.GetContent())
		if f.GetMode()&^0o777 != 0 {
			return invalid("secret_files: " + name + " has an invalid mode")
		}
		if lp := f.GetLinkPath(); lp != "" && !validLinkPath(lp) {
			return invalid("secret_files: link_path of " + name + " must be an absolute path")
		}
	}
	if total > MaxSecretFilesBytes {
		return invalid("secret_files: more than 8 MiB in total")
	}
	return nil
}

// normalizeFiles returns copies of files with the default mode applied.
func normalizeFiles(files []*agentv1.SecretFile) []*agentv1.SecretFile {
	out := make([]*agentv1.SecretFile, 0, len(files))
	for _, f := range files {
		c := &agentv1.SecretFile{Name: f.GetName(), Content: f.GetContent(), Mode: f.GetMode(), LinkPath: f.GetLinkPath()}
		if c.Mode == 0 {
			c.Mode = DefaultSecretFileMode
		}
		out = append(out, c)
	}
	return out
}

// secretsState is the agent's record of the applied secret set in the
// tmpfs (root 0600). It keeps the full secret env, which secrets/env cannot
// hold (multi-line values), so an agent restart without a reboot restores
// the env of commands and verifies the digest. With SecretEnvInMemory
// (Windows) Env is left out and the record holds the file metas only.
type secretsState struct {
	Env   map[string]string `json:"env,omitempty"`
	Files []secretFileMeta  `json:"files"`
}

// secretFileMeta describes one secret file; the content is in files/<name>.
type secretFileMeta struct {
	Name     string `json:"name"`
	Mode     uint32 `json:"mode"`
	LinkPath string `json:"link_path,omitempty"`
}

// writeSecrets replaces the secrets in the tmpfs with env and files
// (normalized): files, stale files and links removed, links, secrets/env,
// then the state record. With SecretEnvInMemory the env stays off the disk.
func (m *Manager) writeSecrets(env map[string]string, files []*agentv1.SecretFile) error {
	if err := m.prepareDirs(); err != nil {
		return internal("prepare secrets", err)
	}
	var old secretsState
	_ = fsutil.ReadJSON(m.l.SecretsStateFile, &old)

	keep := make(map[string]bool, len(files))
	links := make(map[string]bool, len(files))
	st := secretsState{Files: make([]secretFileMeta, 0, len(files))}
	if !m.opts.SecretEnvInMemory {
		st.Env = maps.Clone(env)
	}
	for _, f := range files {
		if err := m.writeSecretFile(f); err != nil {
			return err
		}
		keep[f.GetName()] = true
		st.Files = append(st.Files, secretFileMeta{Name: f.GetName(), Mode: f.GetMode(), LinkPath: f.GetLinkPath()})
	}
	entries, err := os.ReadDir(m.l.SecretFilesDir)
	if err != nil {
		return internal("list secret files", err)
	}
	for _, e := range entries {
		if !keep[e.Name()] {
			if err := m.removeFile(filepath.Join(m.l.SecretFilesDir, e.Name())); err != nil {
				return internal("remove secret file", err)
			}
		}
	}
	for _, f := range files {
		if f.GetLinkPath() == "" {
			continue
		}
		links[f.GetLinkPath()] = true
		if err := m.placeLink(f.GetLinkPath(), filepath.Join(m.l.SecretFilesDir, f.GetName())); err != nil {
			return err
		}
	}
	for _, f := range old.Files {
		if f.LinkPath != "" && !links[f.LinkPath] {
			m.removeLink(f.LinkPath)
		}
	}
	if !m.opts.SecretEnvInMemory {
		if err := m.writeGroupFile(m.l.SecretsEnvFile, FormatEnvFile(env), 0o440); err != nil {
			return err
		}
	}
	data, err := json.Marshal(st)
	if err != nil {
		return internal("encode secrets state", err)
	}
	if err := m.writeFile(m.l.SecretsStateFile, data, 0o600); err != nil {
		return internal("write secrets state", err)
	}
	return nil
}

// writeSecretFile writes one secret file into files/.
func (m *Manager) writeSecretFile(f *agentv1.SecretFile) error {
	return m.writeGroupFile(filepath.Join(m.l.SecretFilesDir, f.GetName()), f.GetContent(), fs.FileMode(f.GetMode()))
}

// loadSecrets reads the applied secret set back from the tmpfs. The env is
// nil when the state holds none (SecretEnvInMemory).
func (m *Manager) loadSecrets() (map[string]string, []*agentv1.SecretFile, error) {
	var st secretsState
	if err := fsutil.ReadJSON(m.l.SecretsStateFile, &st); err != nil {
		return nil, nil, err
	}
	files := make([]*agentv1.SecretFile, 0, len(st.Files))
	for _, f := range st.Files {
		b, err := os.ReadFile(filepath.Join(m.l.SecretFilesDir, f.Name))
		if err != nil {
			return nil, nil, err
		}
		files = append(files, &agentv1.SecretFile{Name: f.Name, Content: b, Mode: f.Mode, LinkPath: f.LinkPath})
	}
	return st.Env, files, nil
}

// wipeSecrets empties the tmpfs secrets: the files in files/ are wiped (see
// wipeDir), secrets/env is truncated (PAM needs the file) and the state
// record removed. Links stay and dangle until the secrets are sent again.
// wiped reports that no secret file is left; files held open (Windows) do
// not fail the call, they leave wiped false.
func (m *Manager) wipeSecrets() (wiped bool, err error) {
	wiped, err = wipeDir(m.l.SecretFilesDir, m.removeFile)
	if err != nil && !errors.Is(err, ErrSecretInUse) {
		return false, err
	}
	if err != nil {
		m.log.Warn("secret files in use, left on disk", "err", err)
	}
	if err := os.Remove(m.l.SecretsStateFile); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return false, internal("remove secrets state", err)
	}
	if !m.opts.SecretEnvInMemory {
		if _, err := os.Stat(m.l.SecretsDir); err == nil {
			if err := m.writeGroupFile(m.l.SecretsEnvFile, nil, 0o440); err != nil {
				return false, err
			}
		}
	}
	return wiped, nil
}

// WipeSecretFiles wipes the secret files and keeps everything else: the
// applied set in memory, the state record, the secrets phase. It continues
// past files that are in use and then fails with ErrSecretInUse; wiped
// reports that no secret file is left. RestoreSecretFiles brings the files
// back (quiesce for a saved snapshot, S9 spec 12.10).
func (m *Manager) WipeSecretFiles() (wiped bool, err error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return wipeDir(m.l.SecretFilesDir, m.removeFile)
}

// RestoreSecretFiles rewrites the applied secret files from memory where
// they are missing or differ, after WipeSecretFiles. Without an applied set
// in memory (secrets pending, for example after an agent restart) it does
// nothing: the files come back with UpdateSecrets.
func (m *Manager) RestoreSecretFiles() error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.RLock()
	files := m.secretFiles
	m.mu.RUnlock()
	if len(files) == 0 {
		return nil
	}
	if err := m.prepareDirs(); err != nil {
		return internal("prepare secrets", err)
	}
	for _, f := range files {
		// A file that was in use was never touched; leave it alone.
		b, err := os.ReadFile(filepath.Join(m.l.SecretFilesDir, f.GetName()))
		if err == nil && bytes.Equal(b, f.GetContent()) {
			continue
		}
		if err := m.writeSecretFile(f); err != nil {
			return err
		}
	}
	return nil
}

// WipeSecretsDir wipes the secret files, the state record and secrets/env
// of layout l without a Manager: the boot step of Windows (sbx-agent early)
// runs it before any logon.
func WipeSecretsDir(l paths.Layout) error {
	_, err := wipeDir(l.SecretFilesDir, removeSecretFile)
	failed := []error{err}
	for _, p := range []string{l.SecretsStateFile, l.SecretsEnvFile} {
		if p == "" {
			continue
		}
		if err := removeSecretFile(p); err != nil {
			failed = append(failed, err)
		}
	}
	return errors.Join(failed...)
}

// wipeDir removes every entry of dir with remove (a zero overwrite on
// Windows). It goes on past failures: wiped reports that dir is empty or
// missing. err matches ErrSecretInUse when every failure was a file in use;
// otherwise it carries the other failures.
func wipeDir(dir string, remove func(string) error) (wiped bool, err error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, internal("list secret files", err)
	}
	var inUse, other []error
	for _, e := range entries {
		if err := remove(filepath.Join(dir, e.Name())); err != nil {
			if errors.Is(err, ErrSecretInUse) {
				inUse = append(inUse, err)
			} else {
				other = append(other, err)
			}
		}
	}
	switch {
	case len(other) > 0:
		return false, internal("remove secret file", errors.Join(other...))
	case len(inUse) > 0:
		return false, errors.Join(inUse...)
	}
	return true, nil
}

// placeLink makes the link_path symlink point at target. An existing
// symlink is replaced; an existing file is moved aside to <path>.sbx-orig
// (or <path>.sbx-orig.<unix nanos> if that is taken) with a warning. An
// existing directory is left alone and the link is skipped with a warning.
// Missing parent directories are created (see mkdirAllOwned).
func (m *Manager) placeLink(linkPath, target string) error {
	link, err := m.l.Rooted(linkPath)
	if err != nil {
		return invalid("secret_files: " + err.Error())
	}
	fi, err := os.Lstat(link)
	switch {
	case err == nil && fi.Mode()&fs.ModeSymlink != 0:
		if cur, err := os.Readlink(link); err == nil && cur == target {
			return nil
		}
	case err == nil && fi.IsDir():
		m.log.Warn("link_path is a directory, secret link skipped", "path", linkPath)
		return nil
	case err == nil:
		aside, err := m.moveAside(link)
		if err != nil {
			return internal("move existing link_path aside", err)
		}
		m.log.Warn("link_path was occupied, moved aside", "path", linkPath, "moved_to", aside)
	case !errors.Is(err, fs.ErrNotExist):
		return internal("inspect link_path", err)
	}
	if err := m.mkdirAllOwned(filepath.Dir(link)); err != nil {
		return internal("create link_path parent", err)
	}
	tmp := link + ".sbx-link-tmp"
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return internal("create link_path", err)
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return internal("create link_path", err)
	}
	return nil
}

// moveAside renames path to a free <path>.sbx-orig name and returns it.
func (m *Manager) moveAside(path string) (string, error) {
	aside := path + ".sbx-orig"
	if _, err := os.Lstat(aside); err == nil {
		aside = path + ".sbx-orig." + strconv.FormatInt(m.opts.Now().UnixNano(), 10)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if err := os.Rename(path, aside); err != nil {
		return "", err
	}
	return aside, nil
}

// removeLink deletes a link_path symlink that still points into files/.
func (m *Manager) removeLink(linkPath string) {
	link, err := m.l.Rooted(linkPath)
	if err != nil {
		return
	}
	target, err := os.Readlink(link)
	if err != nil || filepath.Dir(target) != m.l.SecretFilesDir {
		return
	}
	if err := os.Remove(link); err != nil {
		m.log.Warn("remove stale secret link failed", "err", err)
	}
}
