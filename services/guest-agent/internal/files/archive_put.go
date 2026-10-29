package files

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// extractDir creates entries strictly inside one directory. Paths are
// slash-separated and relative to the directory (validated by
// cleanEntryName). No operation follows a symlink in any component of a
// path: such a path is invalid_path. Errors are either *connect.Error
// (invalid_path) or unmapped filesystem errors.
type extractDir interface {
	// MkdirAll creates the directory rel and its missing parents with perm,
	// owned by o.
	MkdirAll(rel string, perm fs.FileMode, o owner) error
	// Lstat returns the type bits of rel without following it.
	Lstat(rel string) (fs.FileMode, error)
	// Mkdir creates the directory rel.
	Mkdir(rel string, perm fs.FileMode) error
	// Create creates the new file rel (O_EXCL) for writing.
	Create(rel string, perm fs.FileMode) (*os.File, error)
	// Symlink creates rel as a symlink to target.
	Symlink(target, rel string) error
	// Link creates newRel as a hard link to oldRel.
	Link(oldRel, newRel string) error
	// Remove removes the non-directory rel.
	Remove(rel string) error
	// Lchown gives rel (not a symlink target) to o.
	Lchown(rel string, o owner) error
	// ChmodDir sets the mode bits (Unix, with sticky) of the directory rel.
	ChmodDir(rel string, mode uint32) error
	// Chtimes sets the mtime of rel without following it.
	Chtimes(rel string, mtime time.Time) error
	// Close releases the directory.
	Close() error
}

// errInvalidPath is the invalid_path error of an archive entry.
func errInvalidPath(format string, args ...any) error {
	return errs.Newf(connect.CodeInvalidArgument, errs.InvalidPath, format, args...)
}

// tooLarge is the 413 of an archive over a limit.
func tooLarge(format string, args ...any) error {
	return errs.Newf(connect.CodeResourceExhausted, errs.PayloadTooLarge, format, args...)
}

// typeGNUVolume is the GNU tar volume label entry ('V'), which archive/tar
// has no constant for.
const typeGNUVolume byte = 'V'

// archiveResult is the JSON response of PUT /files/archive.
type archiveResult struct {
	Path    string `json:"path"`
	Entries int    `json:"entries"`
	Size    int64  `json:"size"`
}

// archivePut serves PUT /files/archive?path=&user=&owner=&format=tar|tar.gz&
// overwrite=true&make_parents=true: the tar stream is unpacked into the
// directory path. Entries may be files, directories, symlinks and hard
// links to earlier entries; an absolute path, "..", a hard link elsewhere,
// devices and FIFOs are invalid_path, and so is any entry whose path passes
// through a symlink (from the archive or already on disk). Owner is owner
// (default the request user); modes come from the archive without setuid
// and setgid; mtimes are kept. The unpack is not atomic: an error response
// carries entries_written.
func (s *Service) archivePut(w http.ResponseWriter, r *http.Request) {
	x := &extractor{s: s}
	res, err := s.unpack(r, x)
	if err != nil {
		errs.WriteHTTPFields(w, err, map[string]any{"entries_written": x.entries})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// unpack does the work of archivePut; x counts what was written.
func (s *Service) unpack(r *http.Request, x *extractor) (*archiveResult, error) {
	q := r.URL.Query()
	u, root, err := s.resolve(q.Get("user"), q.Get("path"))
	if err != nil {
		return nil, err
	}
	if x.o, err = resolveOwner(q.Get("owner"), u); err != nil {
		return nil, err
	}
	gz, err := parseFormat(q.Get("format"))
	if err != nil {
		return nil, err
	}
	if x.overwrite, err = queryBool(q, "overwrite", true); err != nil {
		return nil, err
	}
	makeParents, err := queryBool(q, "make_parents", true)
	if err != nil {
		return nil, err
	}
	if err := s.waitThaw(r.Context()); err != nil {
		return nil, err
	}
	if makeParents {
		if err := mkdirAll(root, defaultDirMode, x.o); err != nil {
			return nil, fsError(err)
		}
	} else if fi, err := os.Stat(root); err != nil {
		return nil, fsError(err)
	} else if !fi.IsDir() {
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.NotDirectory, "%s is not a directory", root)
	}
	var in io.Reader = r.Body
	if gz {
		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			return nil, invalidArg("gzip: %v", err)
		}
		in = zr
	}
	x.d, err = openExtractDir(root)
	if err != nil {
		return nil, fsError(err)
	}
	defer func() { _ = x.d.Close() }()
	err = x.run(tar.NewReader(in))
	if derr := x.finishDirs(); err == nil {
		err = derr
	}
	if err != nil {
		return nil, mapExtractError(err)
	}
	return &archiveResult{Path: root, Entries: x.entries, Size: x.size}, nil
}

// mapExtractError maps an unpack error: connect errors as they are,
// filesystem errors by errno.
func mapExtractError(err error) error {
	var cerr *connect.Error
	if errors.As(err, &cerr) {
		return cerr
	}
	return fsError(err)
}

// dirMeta is the mode and mtime of an archived directory, applied after
// all entries (writing children changes the mtime, and a read-only mode
// would block them).
type dirMeta struct {
	rel   string
	mode  uint32
	mtime time.Time
}

// extractor unpacks one archive.
type extractor struct {
	s         *Service
	d         extractDir
	o         owner
	overwrite bool

	headers int             // headers seen (the entry limit)
	entries int             // entries written
	size    int64           // file bytes written
	files   map[string]bool // regular files written by this archive (hard link targets)
	dirs    []dirMeta
}

// run unpacks every entry of tr.
func (x *extractor) run(tr *tar.Reader) error {
	x.files = map[string]bool{}
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return invalidArg("read archive: %v", err)
		}
		if x.headers >= x.s.opts.ArchiveMaxEntries {
			return tooLarge("the archive has more than %d entries", x.s.opts.ArchiveMaxEntries)
		}
		x.headers++
		switch hdr.Typeflag {
		case tar.TypeXGlobalHeader, typeGNUVolume:
			// Metadata, not files: a pax global header (the first entry
			// of every git archive) and a GNU volume label.
			continue
		}
		if max(len(hdr.Name), len(hdr.Linkname)) > x.s.opts.ArchiveMaxPath {
			return tooLarge("an entry path is longer than %d bytes", x.s.opts.ArchiveMaxPath)
		}
		rel, err := cleanEntryName(hdr.Name)
		if err != nil {
			return err
		}
		if rel == "." {
			continue // the directory itself
		}
		if err := x.entry(tr, hdr, rel); err != nil {
			return err
		}
		x.entries++
	}
}

// entry unpacks one entry at rel.
func (x *extractor) entry(tr *tar.Reader, hdr *tar.Header, rel string) error {
	switch hdr.Typeflag {
	case tar.TypeReg, tar.TypeGNUSparse:
		return x.file(tr, hdr, rel)
	case tar.TypeDir:
		return x.dir(hdr, rel)
	case tar.TypeSymlink:
		return x.symlink(hdr, rel)
	case tar.TypeLink:
		return x.link(hdr, rel)
	case tar.TypeChar, tar.TypeBlock, tar.TypeFifo:
		return errInvalidPath("%s: devices and FIFOs are not allowed", hdr.Name)
	default:
		return errInvalidPath("%s: unsupported entry type %q", hdr.Name, hdr.Typeflag)
	}
}

// cleanEntryName validates an entry name and returns it relative and
// slash-separated ("." for the directory itself). Absolute names, ".."
// elements and NUL bytes are invalid_path.
func cleanEntryName(name string) (string, error) {
	if name == "" || strings.IndexByte(name, 0) >= 0 {
		return "", errInvalidPath("invalid entry name %q", name)
	}
	if strings.HasPrefix(name, "/") {
		return "", errInvalidPath("%s: absolute entry name", name)
	}
	var out []string
	for elem := range strings.SplitSeq(name, "/") {
		switch elem {
		case "", ".":
		case "..":
			return "", errInvalidPath("%s: entry name with \"..\"", name)
		default:
			out = append(out, elem)
		}
	}
	if len(out) == 0 {
		return ".", nil
	}
	return strings.Join(out, "/"), nil
}

// parentOf returns the parent of a cleaned relative path ("." at the top).
func parentOf(rel string) string {
	i := strings.LastIndexByte(rel, '/')
	if i < 0 {
		return "."
	}
	return rel[:i]
}

// prepare creates the parents of rel and clears the way for a new entry.
// An existing directory is kept for a directory entry (exists=true). Any
// other existing entry is already_exists without overwrite, a directory in
// the way of a non-directory is is_directory, and otherwise it is removed.
func (x *extractor) prepare(rel string, dir bool) (exists bool, err error) {
	if p := parentOf(rel); p != "." {
		if err := x.d.MkdirAll(p, defaultDirMode, x.o); err != nil {
			return false, err
		}
	}
	typ, err := x.d.Lstat(rel)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if dir && typ.IsDir() {
		return true, nil
	}
	if !x.overwrite {
		return false, errs.Newf(connect.CodeAlreadyExists, errs.AlreadyExists, "%s already exists", rel)
	}
	if typ.IsDir() {
		return false, errs.Newf(connect.CodeFailedPrecondition, errs.IsDirectory, "%s is a directory", rel)
	}
	if err := x.d.Remove(rel); err != nil {
		return false, err
	}
	delete(x.files, rel)
	return false, nil
}

// entryMode is the mode of an entry: the archive's permission and sticky
// bits without setuid and setgid.
func entryMode(hdr *tar.Header) uint32 {
	return uint32(hdr.Mode) & 0o1777
}

// file writes a regular file.
func (x *extractor) file(tr *tar.Reader, hdr *tar.Header, rel string) error {
	if hdr.Size < 0 || x.size+hdr.Size > x.s.opts.ArchiveMaxBytes {
		return tooLarge("the archive unpacks to more than %d bytes", x.s.opts.ArchiveMaxBytes)
	}
	if _, err := x.prepare(rel, false); err != nil {
		return err
	}
	f, err := x.d.Create(rel, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, tr)
	x.size += n
	if err != nil {
		_ = f.Close()
		var perr *fs.PathError
		if errors.As(err, &perr) {
			return err
		}
		return invalidArg("read archive: %v", err)
	}
	if err := fchown(f, x.o); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Chmod(toFileMode(entryMode(hdr))); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	x.files[rel] = true
	return x.d.Chtimes(rel, hdr.ModTime)
}

// dir creates a directory; its mode and mtime are set by finishDirs.
func (x *extractor) dir(hdr *tar.Header, rel string) error {
	exists, err := x.prepare(rel, true)
	if err != nil {
		return err
	}
	if !exists {
		if err := x.d.Mkdir(rel, 0o700); err != nil {
			return err
		}
		if err := x.d.Lchown(rel, x.o); err != nil {
			return err
		}
	}
	x.dirs = append(x.dirs, dirMeta{rel: rel, mode: entryMode(hdr), mtime: hdr.ModTime})
	return nil
}

// symlink creates a symlink with the archive's target as is.
func (x *extractor) symlink(hdr *tar.Header, rel string) error {
	if hdr.Linkname == "" || strings.IndexByte(hdr.Linkname, 0) >= 0 {
		return errInvalidPath("%s: invalid symlink target", hdr.Name)
	}
	if _, err := x.prepare(rel, false); err != nil {
		return err
	}
	if err := x.d.Symlink(hdr.Linkname, rel); err != nil {
		return err
	}
	if err := x.d.Lchown(rel, x.o); err != nil {
		return err
	}
	return x.d.Chtimes(rel, hdr.ModTime)
}

// link creates a hard link to a file written earlier by this archive.
func (x *extractor) link(hdr *tar.Header, rel string) error {
	target, err := cleanEntryName(hdr.Linkname)
	if err != nil {
		return err
	}
	if target == rel || !x.files[target] {
		return errInvalidPath("%s: hard link target %q is not an earlier file of the archive", hdr.Name, hdr.Linkname)
	}
	if _, err := x.prepare(rel, false); err != nil {
		return err
	}
	if err := x.d.Link(target, rel); err != nil {
		return err
	}
	x.files[rel] = true
	return nil
}

// finishDirs applies the mode and mtime of the archived directories in
// reverse archive order, so children usually come before their parents. It
// also runs after a failed unpack; the first error is returned.
func (x *extractor) finishDirs() error {
	var first error
	for _, m := range slices.Backward(x.dirs) {
		err := x.d.ChmodDir(m.rel, m.mode)
		if err == nil {
			err = x.d.Chtimes(m.rel, m.mtime)
		}
		if err != nil && first == nil {
			first = err
		}
	}
	return first
}
