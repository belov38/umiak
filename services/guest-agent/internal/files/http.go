package files

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/belov38/boat-dev-clone/libs/tunnel/wire"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
)

// HeaderUploadOffset carries the current size of an upload. It is the only
// Sbx-* response header of /files.
const HeaderUploadOffset = wire.HeaderUploadOffset

// uploadIDRE is the syntax of an upload id. It is matched against the
// escaped path segment, so %2F, %5C and dot segments never pass.
var uploadIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// HTTPHandler returns the handler of the /files endpoints (spec 11.2). Mount
// it at /files and /files/. Routes:
//
//	GET|HEAD /files                     file content
//	PUT      /files                     atomic write
//	PUT      /files/uploads/{id}        upload chunk
//	HEAD     /files/uploads/{id}        upload offset
//	DELETE   /files/uploads/{id}        cancel upload
//	POST     /files/uploads/{id}/commit commit upload
//	GET      /files/archive             directory as tar
//	PUT      /files/archive             unpack tar into a directory
//
// Anything else is 404. Responses are never compressed.
func (s *Service) HTTPHandler() http.Handler {
	return http.HandlerFunc(s.serveHTTP)
}

func (s *Service) serveHTTP(w http.ResponseWriter, r *http.Request) {
	rest, ok := strings.CutPrefix(r.URL.EscapedPath(), "/files")
	if !ok {
		notFound(w)
		return
	}
	switch {
	case rest == "":
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			s.download(w, r)
		case http.MethodPut:
			s.putFile(w, r)
		default:
			methodNotAllowed(w, "GET, HEAD, PUT")
		}
	case rest == "/archive":
		switch r.Method {
		case http.MethodGet:
			s.archiveGet(w, r)
		case http.MethodPut:
			s.archivePut(w, r)
		default:
			methodNotAllowed(w, "GET, PUT")
		}
	case strings.HasPrefix(rest, "/uploads/"):
		s.serveUpload(w, r, strings.Split(rest[len("/uploads/"):], "/"))
	default:
		notFound(w)
	}
}

// serveUpload routes /files/uploads/{id}[/commit]; segs are the escaped
// segments after /files/uploads/.
func (s *Service) serveUpload(w http.ResponseWriter, r *http.Request, segs []string) {
	if len(segs) > 2 || (len(segs) == 2 && segs[1] != "commit") {
		notFound(w)
		return
	}
	id := segs[0]
	if !uploadIDRE.MatchString(id) {
		errs.WriteHTTP(w, errs.New(connect.CodeInvalidArgument, errs.InvalidPath, "invalid upload id"))
		return
	}
	if len(segs) == 2 {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		s.commit(w, r, id)
		return
	}
	switch r.Method {
	case http.MethodPut:
		s.putChunk(w, r, id)
	case http.MethodHead:
		s.headUpload(w, id)
	case http.MethodDelete:
		s.deleteUpload(w, r, id)
	default:
		methodNotAllowed(w, "PUT, HEAD, DELETE")
	}
}

func notFound(w http.ResponseWriter) {
	errs.WriteHTTP(w, errs.HTTPError{Status: http.StatusNotFound, Code: "not_found", Message: "no such endpoint"})
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	errs.WriteHTTP(w, errs.HTTPError{Status: http.StatusMethodNotAllowed, Code: "unimplemented", Message: "method not allowed"})
}

// writeJSON writes v as a JSON response.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeRawJSON writes a JSON body as is.
func writeRawJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// marshalProto encodes a message as protojson: the JSON form of the proto
// messages (FileInfo) that clients decode with the generated types. The
// output is compacted: protojson varies its whitespace on purpose, and a
// stored commit result must replay byte for byte.
func marshalProto(m proto.Message) ([]byte, error) {
	b, err := protojson.Marshal(m)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, b); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// queryBool parses a boolean query parameter; absent means def.
func queryBool(q url.Values, key string, def bool) (bool, error) {
	if !q.Has(key) {
		return def, nil
	}
	b, err := strconv.ParseBool(q.Get(key))
	if err != nil {
		return false, invalidArg("%s=%q is not a boolean", key, q.Get(key))
	}
	return b, nil
}

// queryMode parses an octal mode query parameter; absent means def.
func queryMode(q url.Values, def fs.FileMode) (fs.FileMode, error) {
	if !q.Has("mode") {
		return def, nil
	}
	m, err := parseMode(q.Get("mode"))
	if err != nil {
		return 0, err
	}
	return toFileMode(m), nil
}

// randomSuffix returns 16 hex characters.
func randomSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// writeTemp copies r into a new temporary file ".sbx-tmp-*" in dir, fsyncs
// it and gives it owner o and mode (after the chown, which may clear
// setuid bits). It returns the path of the closed file; on error nothing is
// left behind.
func writeTemp(dir string, r io.Reader, mode fs.FileMode, o owner) (path string, err error) {
	f, err := os.CreateTemp(dir, ".sbx-tmp-*")
	if err != nil {
		return "", fsError(err)
	}
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(f.Name())
		}
	}()
	if _, err = io.Copy(f, r); err != nil {
		var perr *fs.PathError
		if errors.As(err, &perr) {
			return "", fsError(err)
		}
		return "", invalidArg("read request body: %v", err)
	}
	if err = f.Sync(); err != nil {
		return "", fsError(err)
	}
	if err = fchown(f, o); err != nil {
		return "", fsError(err)
	}
	if err = f.Chmod(mode); err != nil {
		return "", fsError(err)
	}
	if err = f.Close(); err != nil {
		return "", fsError(err)
	}
	return f.Name(), nil
}

// place moves the finished file tmp to dst and fsyncs the directory. With
// overwrite an existing dst is replaced atomically (rename); without, a
// hard link refuses an existing dst atomically (already_exists). tmp is
// left in place on error; EXDEV is returned unmapped so callers can copy.
func place(tmp, dst string, overwrite bool) error {
	if overwrite {
		if err := os.Rename(tmp, dst); err != nil {
			return err
		}
	} else {
		if err := os.Link(tmp, dst); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return errs.Newf(connect.CodeAlreadyExists, errs.AlreadyExists, "%s already exists", dst)
			}
			return err
		}
		_ = os.Remove(tmp)
	}
	return syncDir(filepath.Dir(dst))
}

// isCrossDevice reports a rename across filesystems.
func isCrossDevice(err error) bool { return errors.Is(err, syscall.EXDEV) }

// placeTemp is place for a temporary file of this request: it is removed
// on error and errors are mapped.
func placeTemp(tmp, dst string, overwrite bool) error {
	if err := place(tmp, dst, overwrite); err != nil {
		_ = os.Remove(tmp)
		return fsError(err)
	}
	return nil
}

// syncDir fsyncs a directory so a rename into it survives a crash. Windows
// cannot sync directories; there it is a no-op.
func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	if err := d.Sync(); err != nil && !errors.Is(err, syscall.EINVAL) {
		return err
	}
	return nil
}
