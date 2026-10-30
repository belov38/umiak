package files

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// defaultFileMode is the mode of files written without an explicit one.
const defaultFileMode fs.FileMode = 0o644

// download serves GET and HEAD /files?path=&user=: the file content with
// a single Range, If-Range, ETag "<inode>-<size>-<mtime_ns>",
// Last-Modified and Accept-Ranges (http.ServeContent). Several ranges get
// the whole file with 200. A directory is is_directory.
func (s *Service) download(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	_, p, err := s.resolve(q.Get("user"), q.Get("path"))
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	f, err := openRead(p)
	if err != nil {
		errs.WriteHTTP(w, fsError(err))
		return
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		errs.WriteHTTP(w, fsError(err))
		return
	}
	if fi.IsDir() {
		errs.WriteHTTP(w, errs.Newf(connect.CodeFailedPrecondition, errs.IsDirectory, "%s is a directory", p))
		return
	}
	if !fi.Mode().IsRegular() {
		errs.WriteHTTP(w, errs.Newf(connect.CodeFailedPrecondition, errs.FailedPrecondition, "%s is not a regular file", p))
		return
	}
	if strings.Contains(r.Header.Get("Range"), ",") {
		r.Header.Del("Range")
	}
	h := w.Header()
	h.Set("ETag", fmt.Sprintf(`"%d-%d-%d"`, sysOf(fi).ino, fi.Size(), fi.ModTime().UnixNano()))
	h.Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// putFile serves PUT /files?path=&user=&mode=&owner=&make_parents=true&
// overwrite=true: the body goes to a temporary file in the target
// directory, which is fsynced, given its owner and mode and renamed over the
// target. The response is the FileInfo JSON. A symlink at path is followed.
func (s *Service) putFile(w http.ResponseWriter, r *http.Request) {
	info, err := s.writeFile(r)
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	body, err := marshalProto(info)
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, body)
}

// writeFile does the work of putFile and returns the FileInfo of path.
func (s *Service) writeFile(r *http.Request) (*agentv1.FileInfo, error) {
	q := r.URL.Query()
	u, p, err := s.resolve(q.Get("user"), q.Get("path"))
	if err != nil {
		return nil, err
	}
	o, err := resolveOwner(q.Get("owner"), u)
	if err != nil {
		return nil, err
	}
	mode, err := queryMode(q, defaultFileMode)
	if err != nil {
		return nil, err
	}
	makeParents, err := queryBool(q, "make_parents", true)
	if err != nil {
		return nil, err
	}
	overwrite, err := queryBool(q, "overwrite", true)
	if err != nil {
		return nil, err
	}
	if err := s.waitThaw(r.Context()); err != nil {
		return nil, err
	}
	target, err := prepareTarget(p, o, overwrite, makeParents)
	if err != nil {
		return nil, err
	}
	tmp, err := writeTemp(filepath.Dir(target), r.Body, mode, o)
	if err != nil {
		return nil, err
	}
	if err := placeTemp(tmp, target, overwrite); err != nil {
		return nil, err
	}
	info, err := statInfo(p, true, newNames())
	if err != nil {
		return nil, fsError(err)
	}
	return info, nil
}

// prepareTarget follows a symlink at p to the file a write replaces,
// refuses a directory (and an existing file without overwrite) and creates
// the missing parents when makeParents is set.
func prepareTarget(p string, o owner, overwrite, makeParents bool) (string, error) {
	target, err := followLinks(p)
	if err != nil {
		return "", fsError(err)
	}
	fi, err := os.Stat(target)
	switch {
	case err == nil && fi.IsDir():
		return "", errs.Newf(connect.CodeFailedPrecondition, errs.IsDirectory, "%s is a directory", p)
	case err == nil && !overwrite:
		return "", errs.Newf(connect.CodeAlreadyExists, errs.AlreadyExists, "%s already exists", p)
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return "", fsError(err)
	}
	if makeParents {
		if err := mkdirAll(filepath.Dir(target), defaultDirMode, o); err != nil {
			return "", fsError(err)
		}
	}
	return target, nil
}
