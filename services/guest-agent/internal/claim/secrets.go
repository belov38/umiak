package claim

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
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
)

// Secret limits (spec 8.1).
const (
	MaxSecretFileBytes  = 1 << 20
	MaxSecretFilesBytes = 8 << 20
	// DefaultSecretFileMode applies to a secret file without a mode.
	DefaultSecretFileMode = 0o440
)

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
		if lp := f.GetLinkPath(); lp != "" {
			if !strings.HasPrefix(lp, "/") || slices.Contains(strings.Split(lp, "/"), "..") || filepath.Clean(lp) == "/" {
				return invalid("secret_files: link_path of " + name + " must be an absolute path")
			}
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
// the env of commands and verifies the digest.
type secretsState struct {
	Env   map[string]string `json:"env"`
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
// then the state record.
func (m *Manager) writeSecrets(env map[string]string, files []*agentv1.SecretFile) error {
	if err := m.prepareDirs(); err != nil {
		return internal("prepare secrets", err)
	}
	var old secretsState
	_ = fsutil.ReadJSON(m.l.SecretsStateFile, &old)

	keep := make(map[string]bool, len(files))
	links := make(map[string]bool, len(files))
	st := secretsState{Env: maps.Clone(env), Files: make([]secretFileMeta, 0, len(files))}
	for _, f := range files {
		p := filepath.Join(m.l.SecretFilesDir, f.GetName())
		if err := m.writeGroupFile(p, f.GetContent(), fs.FileMode(f.GetMode())); err != nil {
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
			if err := os.RemoveAll(filepath.Join(m.l.SecretFilesDir, e.Name())); err != nil {
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
	if err := m.writeGroupFile(m.l.SecretsEnvFile, FormatEnvFile(env), 0o440); err != nil {
		return err
	}
	if err := fsutil.WriteJSONAtomic(m.l.SecretsStateFile, st, 0o600); err != nil {
		return internal("write secrets state", err)
	}
	return nil
}

// loadSecrets reads the applied secret set back from the tmpfs.
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

// wipeSecrets empties the tmpfs secrets: files/ is emptied, secrets/env is
// truncated (PAM needs the file) and the state record removed. Links stay
// and dangle until the secrets are sent again.
func (m *Manager) wipeSecrets() error {
	entries, err := os.ReadDir(m.l.SecretFilesDir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return internal("list secret files", err)
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(m.l.SecretFilesDir, e.Name())); err != nil {
			return internal("remove secret file", err)
		}
	}
	if err := os.Remove(m.l.SecretsStateFile); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return internal("remove secrets state", err)
	}
	if _, err := os.Stat(m.l.SecretsDir); err == nil {
		if err := m.writeGroupFile(m.l.SecretsEnvFile, nil, 0o440); err != nil {
			return err
		}
	}
	return nil
}

// writeGroupFile writes a tmpfs file with mode and the default user's
// group.
func (m *Manager) writeGroupFile(path string, data []byte, mode fs.FileMode) error {
	if err := fsutil.WriteFileAtomic(path, data, mode); err != nil {
		return internal("write secret", err)
	}
	return m.chownGroup(path)
}

// chownGroup gives path the default user's group; the owner is unchanged
// (root in production). Without a known user it does nothing.
func (m *Manager) chownGroup(path string) error {
	m.mu.RLock()
	u := m.user
	m.mu.RUnlock()
	if u == nil {
		return nil
	}
	if err := os.Lchown(path, -1, int(u.GID)); err != nil {
		return internal("chown secret", err)
	}
	return nil
}

// placeLink makes the link_path symlink point at target. An existing
// symlink is replaced; an existing file or directory is moved aside to
// <path>.sbx-orig (or <path>.sbx-orig.<unix nanos> if that is taken) with a
// warning. Missing parent directories are created (see mkdirAllOwned).
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

// mkdirAllOwned creates dir and its missing parents (0755, root). Created
// directories inside the default user's home (after resolving symlinks, so
// a symlink in the home cannot hand out directories elsewhere) are given to
// the user; the others stay root-owned.
func (m *Manager) mkdirAllOwned(dir string) error {
	var missing []string
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Lstat(d); err == nil {
			break
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		missing = append(missing, d)
		if filepath.Dir(d) == d {
			break
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	m.mu.RLock()
	u := m.user
	m.mu.RUnlock()
	if u == nil || u.Home == "" || len(missing) == 0 {
		return nil
	}
	home, err := m.l.Rooted(u.Home)
	if err != nil {
		return nil
	}
	if home, err = filepath.EvalSymlinks(home); err != nil {
		return nil
	}
	for _, d := range missing {
		resolved, err := filepath.EvalSymlinks(d)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(resolved, home+string(filepath.Separator)) {
			continue
		}
		if err := os.Lchown(resolved, int(u.UID), int(u.GID)); err != nil {
			return fmt.Errorf("chown %s: %w", d, err)
		}
	}
	return nil
}
