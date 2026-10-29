package files

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"connectrpc.com/connect"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// parseFormat parses the format query parameter of /files/archive:
// "tar" (default) or "tar.gz".
func parseFormat(f string) (gz bool, err error) {
	switch f {
	case "", "tar":
		return false, nil
	case "tar.gz":
		return true, nil
	default:
		return false, invalidArg("format %q is not tar or tar.gz", f)
	}
}

// archiveGet serves GET /files/archive?path=&user=&format=tar|tar.gz: the
// directory as one POSIX pax tar stream (optionally gzipped), names
// relative to path. The walk does not follow symlinks (they are archived
// as symlinks); hardlinks are archived as separate files; sockets, FIFOs
// and devices are skipped. There is no snapshot: files are archived as
// read. An error after the response started aborts the connection, so the
// client sees an archive without its end blocks.
func (s *Service) archiveGet(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	_, root, err := s.resolve(q.Get("user"), q.Get("path"))
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	gz, err := parseFormat(q.Get("format"))
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	fi, err := os.Stat(root)
	if err != nil {
		errs.WriteHTTP(w, fsError(err))
		return
	}
	if !fi.IsDir() {
		errs.WriteHTTP(w, errs.Newf(connect.CodeFailedPrecondition, errs.NotDirectory, "%s is not a directory", root))
		return
	}
	if gz {
		w.Header().Set("Content-Type", "application/gzip")
	} else {
		w.Header().Set("Content-Type", "application/x-tar")
	}
	w.WriteHeader(http.StatusOK)

	var out io.Writer = w
	var zw *gzip.Writer
	if gz {
		zw = gzip.NewWriter(w)
		out = zw
	}
	tw := tar.NewWriter(out)
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p != root && errors.Is(err, fs.ErrNotExist) {
				return nil // removed while walking
			}
			return err
		}
		if p == root {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		return writeTarEntry(tw, p, filepath.ToSlash(rel), d)
	})
	if err == nil {
		err = tw.Close()
	}
	if err == nil && zw != nil {
		err = zw.Close()
	}
	if err != nil {
		s.opts.Log.Warn("files: archive aborted", "path", root, "err", err)
		// Abort without the end blocks of the tar stream.
		panic(http.ErrAbortHandler)
	}
}

// writeTarEntry archives the entry d found at p under name.
func writeTarEntry(tw *tar.Writer, p, name string, d fs.DirEntry) error {
	typ := d.Type()
	switch {
	case typ.IsDir(), typ&fs.ModeSymlink != 0, typ.IsRegular():
	default:
		return nil // sockets, FIFOs, devices
	}
	if typ.IsRegular() {
		return writeTarFile(tw, p, name)
	}
	fi, err := d.Info()
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	var link string
	if typ&fs.ModeSymlink != 0 {
		if link, err = os.Readlink(p); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
	}
	hdr, err := tarHeader(fi, name, link)
	if err != nil {
		return err
	}
	return tw.WriteHeader(hdr)
}

// writeTarFile archives a regular file with the size it has when opened.
func writeTarFile(tw *tar.Writer, p, name string) error {
	f, err := openRead(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return nil // replaced while walking
	}
	hdr, err := tarHeader(fi, name, "")
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	// A file that grew is cut at the header size; one that shrank fails.
	_, err = io.CopyN(tw, f, hdr.Size)
	return err
}

// tarHeader builds a pax header for fi under name.
func tarHeader(fi fs.FileInfo, name, link string) (*tar.Header, error) {
	hdr, err := tar.FileInfoHeader(fi, link)
	if err != nil {
		return nil, err
	}
	hdr.Name = name
	if fi.IsDir() {
		hdr.Name += "/"
	}
	hdr.Format = tar.FormatPAX
	hdr.AccessTime, hdr.ChangeTime = time.Time{}, time.Time{}
	return hdr, nil
}
