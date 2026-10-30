package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// maxCommitBody bounds the JSON body of a commit.
const maxCommitBody = 64 << 10

// janitorInterval is the period of the upload janitor.
const janitorInterval = time.Hour

// commitRequest is the JSON body of POST /files/uploads/{id}/commit.
type commitRequest struct {
	Path        string  `json:"path"`
	SHA256      string  `json:"sha256"`
	Mode        *uint32 `json:"mode"`
	Owner       string  `json:"owner"`
	Overwrite   *bool   `json:"overwrite"`
	MakeParents *bool   `json:"make_parents"`
	// MakeParentsCamel accepts the camelCase spelling of the public API.
	MakeParentsCamel *bool `json:"makeParents"`
}

// offsetResponse is the JSON body of a chunk response.
type offsetResponse struct {
	Offset uint64 `json:"offset"`
}

// uploadNotFound is the error for an unknown upload id.
func uploadNotFound(id string) error {
	return errs.Newf(connect.CodeNotFound, errs.UploadNotFound, "upload %q not found", id)
}

// offsetMismatch is the 409 of a chunk at the wrong offset; the caller sets
// the Sbx-Upload-Offset header.
func offsetMismatch(want, got uint64) error {
	return errs.HTTPError{
		Status:  http.StatusConflict,
		Code:    errs.UploadOffsetMismatch,
		Message: "offset " + strconv.FormatUint(got, 10) + " does not match the upload size " + strconv.FormatUint(want, 10),
	}
}

// putUpload durably stores rec within the durable timeout.
func (s *Service) putUpload(ctx context.Context, rec *store.Upload) error {
	ctx, cancel := s.durableCtx(ctx)
	defer cancel()
	if err := s.st.PutUpload(ctx, rec); err != nil {
		return storeError(err)
	}
	return nil
}

// deleteUploadRecord durably removes the record of id.
func (s *Service) deleteUploadRecord(ctx context.Context, id string) error {
	ctx, cancel := s.durableCtx(ctx)
	defer cancel()
	if err := s.st.DeleteUpload(ctx, id); err != nil {
		return storeError(err)
	}
	return nil
}

// getUpload reads the record of id.
func (s *Service) getUpload(id string) (*store.Upload, bool, error) {
	rec, ok, err := s.st.GetUpload(id)
	if err != nil {
		return nil, false, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	return rec, ok, nil
}

// putChunk serves PUT /files/uploads/{id}?offset=&path=&user=. The chunk
// (at most MaxChunk bytes) is appended at offset, which must equal the
// current size; otherwise 409 with Sbx-Upload-Offset. The first chunk
// creates the upload; path is the hint where to keep its temporary file
// (spec 11.3).
func (s *Service) putChunk(w http.ResponseWriter, r *http.Request, id string) {
	size, err := s.writeChunk(r, id)
	if size >= 0 {
		w.Header().Set(HeaderUploadOffset, strconv.FormatUint(uint64(size), 10))
	}
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	writeJSON(w, http.StatusOK, offsetResponse{Offset: uint64(size)})
}

// writeChunk stores one chunk and returns the upload size afterwards. A
// non-negative size is also returned with an offset mismatch, for the
// header; it is -1 when unknown.
func (s *Service) writeChunk(r *http.Request, id string) (int64, error) {
	q := r.URL.Query()
	offset, err := strconv.ParseUint(q.Get("offset"), 10, 63)
	if err != nil {
		return -1, invalidArg("offset %q is not a non-negative integer", q.Get("offset"))
	}
	if r.ContentLength > s.opts.MaxChunk {
		return -1, s.chunkTooLarge()
	}
	if err := s.waitThaw(r.Context()); err != nil {
		return -1, err
	}
	unlock, err := s.uploads.lock(r.Context(), id)
	if err != nil {
		return -1, connect.NewError(connect.CodeCanceled, err)
	}
	defer unlock()

	rec, ok, err := s.getUpload(id)
	if err != nil {
		return -1, err
	}
	if ok && rec.Commit != nil {
		return rec.Size, errs.HTTPError{Status: http.StatusConflict, Code: errs.FailedPrecondition, Message: "upload " + id + " is already committed"}
	}
	if ok && rec.CommitTarget != "" {
		// A commit started (the file may already be at its target, the
		// result lost): the upload is complete at its recorded size. Only
		// a commit retry finishes it.
		return rec.Size, offsetMismatch(uint64(max(rec.Size, 0)), offset)
	}
	var f *os.File
	if ok {
		f, err = os.OpenFile(rec.TempPath, os.O_RDWR, 0)
		if errors.Is(err, fs.ErrNotExist) {
			// The temporary file is gone: the upload starts over.
			if err := s.deleteUploadRecord(r.Context(), id); err != nil {
				return -1, err
			}
			ok = false
		} else if err != nil {
			return -1, fsError(err)
		}
	}
	if !ok {
		if offset != 0 {
			return 0, offsetMismatch(0, offset)
		}
		tempPath, err := s.tempPathFor(id, q)
		if err != nil {
			return -1, err
		}
		now := s.opts.Now()
		rec = &store.Upload{ID: id, TempPath: tempPath, CreatedAt: now, LastActivity: now}
		// The record comes first, so the janitor always knows the file.
		if err := s.putUpload(r.Context(), rec); err != nil {
			return -1, err
		}
		f, err = os.OpenFile(tempPath, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return -1, fsError(err)
		}
	}
	defer func() { _ = f.Close() }()

	// The record is the truth: bytes past it were written by a chunk whose
	// record update did not happen.
	fi, err := f.Stat()
	if err != nil {
		return -1, fsError(err)
	}
	cur := min(fi.Size(), rec.Size)
	if uint64(cur) != offset {
		return cur, offsetMismatch(uint64(cur), offset)
	}
	if fi.Size() != cur {
		if err := f.Truncate(cur); err != nil {
			return -1, fsError(err)
		}
	}
	if _, err := f.Seek(cur, io.SeekStart); err != nil {
		return -1, fsError(err)
	}
	n, err := io.Copy(f, io.LimitReader(r.Body, s.opts.MaxChunk+1))
	if err == nil && n > s.opts.MaxChunk {
		err = s.chunkTooLarge()
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		_ = f.Truncate(cur)
		var cerr *connect.Error
		var perr *fs.PathError
		switch {
		case errors.As(err, &cerr):
		case errors.As(err, &perr):
			err = fsError(err)
		default:
			err = invalidArg("read chunk: %v", err)
		}
		return cur, err
	}
	rec.Size = cur + n
	rec.LastActivity = s.opts.Now()
	if err := s.putUpload(r.Context(), rec); err != nil {
		return -1, err
	}
	return rec.Size, nil
}

// chunkTooLarge is the 413 of a chunk over MaxChunk.
func (s *Service) chunkTooLarge() error {
	return errs.Newf(connect.CodeResourceExhausted, errs.PayloadTooLarge, "a chunk is at most %d bytes", s.opts.MaxChunk)
}

// tempPathFor chooses the temporary file of a new upload (spec 11.3):
// UploadsDir/<id> unless the path hint q["path"] names a directory on
// another filesystem than StateDir, then .sbx-upload-<id> in that
// directory.
func (s *Service) tempPathFor(id string, q url.Values) (string, error) {
	inState := filepath.Join(s.opts.Layout.UploadsDir, id)
	if hint := q.Get("path"); hint != "" {
		_, p, err := s.resolve(q.Get("user"), hint)
		if err != nil {
			return "", err
		}
		target, err := followLinks(p)
		if err != nil {
			return "", fsError(err)
		}
		dir := filepath.Dir(target)
		stateDev, ok1 := deviceOf(s.opts.Layout.StateDir)
		dirDev, ok2 := deviceOf(dir)
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() && ok1 && ok2 && stateDev != dirDev {
			return filepath.Join(dir, ".sbx-upload-"+id), nil
		}
	}
	if err := os.MkdirAll(s.opts.Layout.UploadsDir, 0o700); err != nil {
		return "", fsError(err)
	}
	return inState, nil
}

// headUpload serves HEAD /files/uploads/{id}: Sbx-Upload-Offset, or 404.
func (s *Service) headUpload(w http.ResponseWriter, id string) {
	rec, ok, err := s.getUpload(id)
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	if !ok {
		errs.WriteHTTP(w, uploadNotFound(id))
		return
	}
	w.Header().Set(HeaderUploadOffset, strconv.FormatUint(uint64(max(rec.Size, 0)), 10))
	w.WriteHeader(http.StatusOK)
}

// deleteUpload serves DELETE /files/uploads/{id}: the upload and its
// temporary file are removed (a committed file stays).
func (s *Service) deleteUpload(w http.ResponseWriter, r *http.Request, id string) {
	if err := s.waitThaw(r.Context()); err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	unlock, err := s.uploads.lock(r.Context(), id)
	if err != nil {
		errs.WriteHTTP(w, connect.NewError(connect.CodeCanceled, err))
		return
	}
	defer unlock()
	rec, ok, err := s.getUpload(id)
	if err == nil && !ok {
		err = uploadNotFound(id)
	}
	if err == nil {
		err = s.dropUpload(r.Context(), rec)
	}
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// dropUpload removes the record, then the temporary file. A file left by
// a failed removal is an orphan the janitor sweeps.
func (s *Service) dropUpload(ctx context.Context, rec *store.Upload) error {
	if err := s.deleteUploadRecord(ctx, rec.ID); err != nil {
		return err
	}
	if rec.TempPath != "" {
		_ = os.Remove(rec.TempPath)
	}
	return nil
}

// commit serves POST /files/uploads/{id}/commit?user= with a JSON body
// {path, sha256?, mode?, owner?, overwrite=true, make_parents=true}. The
// temporary file is renamed (or, across filesystems, copied) to path and
// the FileInfo JSON is stored in the upload record: a repeated commit
// replays it for UploadTTL. A sha256 mismatch deletes the upload (422).
func (s *Service) commit(w http.ResponseWriter, r *http.Request, id string) {
	body, err := s.commitUpload(r, id)
	if err != nil {
		errs.WriteHTTP(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, body)
}

// commitUpload does the work of commit and returns the FileInfo JSON.
func (s *Service) commitUpload(r *http.Request, id string) ([]byte, error) {
	unlock, err := s.uploads.lock(r.Context(), id)
	if err != nil {
		return nil, connect.NewError(connect.CodeCanceled, err)
	}
	defer unlock()
	rec, ok, err := s.getUpload(id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, uploadNotFound(id)
	}
	if rec.Commit != nil {
		return rec.Commit, nil
	}

	var req commitRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxCommitBody)).Decode(&req); err != nil {
		return nil, invalidArg("commit body: %v", err)
	}
	u, p, err := s.resolve(r.URL.Query().Get("user"), req.Path)
	if err != nil {
		return nil, err
	}
	o, err := resolveOwner(req.Owner, u)
	if err != nil {
		return nil, err
	}
	mode := defaultFileMode
	if req.Mode != nil {
		if *req.Mode > 0o7777 {
			return nil, invalidArg("mode %d is out of range", *req.Mode)
		}
		mode = toFileMode(*req.Mode)
	}
	overwrite := req.Overwrite == nil || *req.Overwrite
	makeParents := true
	switch {
	case req.MakeParents != nil:
		makeParents = *req.MakeParents
	case req.MakeParentsCamel != nil:
		makeParents = *req.MakeParentsCamel
	}
	if err := s.waitThaw(r.Context()); err != nil {
		return nil, err
	}

	if done, err := s.movedEarlier(rec); err != nil {
		return nil, err
	} else if done {
		// An earlier attempt moved the file but lost its result.
		return s.storeCommit(r.Context(), rec)
	}
	if _, err := os.Lstat(rec.TempPath); errors.Is(err, fs.ErrNotExist) {
		if err := s.deleteUploadRecord(r.Context(), id); err != nil {
			return nil, err
		}
		return nil, uploadNotFound(id)
	}
	if want := req.SHA256; want != "" {
		got, err := fileSHA256(rec.TempPath)
		if err != nil {
			return nil, fsError(err)
		}
		if !strings.EqualFold(got, want) {
			if err := s.dropUpload(r.Context(), rec); err != nil {
				return nil, err
			}
			return nil, errs.HTTPError{Status: http.StatusUnprocessableEntity, Code: errs.ChecksumMismatch, Message: "sha256 of the upload is " + got}
		}
	}
	target, err := prepareTarget(p, o, overwrite, makeParents)
	if err != nil {
		return nil, err
	}
	// The intent is durable before the file moves, so a retry after a lost
	// result finds the file at its target instead of a missing upload.
	rec.CommitPath, rec.CommitTarget = p, target
	if err := s.putUpload(r.Context(), rec); err != nil {
		return nil, err
	}
	if err := finishUpload(rec.TempPath, target, mode, o, overwrite); err != nil {
		return nil, err
	}
	if s.testHookAfterPlace != nil {
		s.testHookAfterPlace()
	}
	return s.storeCommit(r.Context(), rec)
}

// movedEarlier reports whether an earlier commit of rec already moved the
// upload to its recorded target: the upload file is gone (or is the same
// file as the target, a hard link not yet removed) and the target exists.
func (s *Service) movedEarlier(rec *store.Upload) (bool, error) {
	if rec.CommitTarget == "" {
		return false, nil
	}
	tfi, err := os.Stat(rec.CommitTarget)
	if err != nil {
		return false, nil
	}
	ufi, err := os.Lstat(rec.TempPath)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return true, nil
	case err != nil:
		return false, fsError(err)
	case os.SameFile(tfi, ufi):
		if err := os.Remove(rec.TempPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return false, fsError(err)
		}
		return true, nil
	}
	return false, nil
}

// storeCommit stores the FileInfo of a committed upload as its result and
// returns it. The write is detached from the call (bounded by
// DurableTimeout): a client that gave up after the move must still find the
// result when it retries.
func (s *Service) storeCommit(ctx context.Context, rec *store.Upload) ([]byte, error) {
	info, err := statInfo(rec.CommitPath, true, newNames())
	if err != nil {
		return nil, fsError(err)
	}
	body, err := marshalProto(info)
	if err != nil {
		return nil, errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
	rec.Commit = body
	rec.TempPath = ""
	rec.LastActivity = s.opts.Now()
	if err := s.putUpload(context.WithoutCancel(ctx), rec); err != nil {
		return nil, err
	}
	return body, nil
}

// finishUpload gives the temporary file of an upload its owner and mode
// and moves it to target. Across filesystems it is copied to a temporary
// file next to target, fsynced and renamed, then removed. On error the
// upload file stays where it was.
func finishUpload(tempPath, target string, mode fs.FileMode, o owner, overwrite bool) error {
	if err := lchown(tempPath, o); err != nil {
		return fsError(err)
	}
	if err := os.Chmod(tempPath, mode); err != nil {
		return fsError(err)
	}
	err := place(tempPath, target, overwrite)
	if err == nil {
		return nil
	}
	if !isCrossDevice(err) {
		return fsError(err)
	}
	in, err := os.Open(tempPath)
	if err != nil {
		return fsError(err)
	}
	defer func() { _ = in.Close() }()
	tmp, err := writeTemp(filepath.Dir(target), in, mode, o)
	if err != nil {
		return err
	}
	if err := placeTemp(tmp, target, overwrite); err != nil {
		return err
	}
	_ = os.Remove(tempPath)
	return nil
}

// fileSHA256 returns the hex sha256 of a file.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
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

// UploadPath returns the file of upload id: the temporary file of a live
// upload or the target of a committed one (used by ApplyUpdate). An unknown
// upload is upload_not_found.
func (s *Service) UploadPath(id string) (string, error) {
	rec, ok, err := s.getUpload(id)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", uploadNotFound(id)
	}
	if rec.Commit != nil {
		var info agentv1.FileInfo
		if err := protojson.Unmarshal(rec.Commit, &info); err != nil {
			return "", errs.New(connect.CodeInternal, errs.Internal, "upload "+id+": stored result: "+err.Error())
		}
		return info.GetPath(), nil
	}
	if rec.CommitPath != "" {
		if _, err := os.Lstat(rec.TempPath); errors.Is(err, fs.ErrNotExist) {
			return rec.CommitPath, nil // moved; the result is not stored yet
		}
	}
	return rec.TempPath, nil
}

// ForgetUpload drops upload id and its temporary file, like DELETE
// /files/uploads/{id}; ApplyUpdate calls it after it removed the package
// of the upload. An unknown id is ignored; failures are logged (the
// janitor expires the record later).
func (s *Service) ForgetUpload(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), s.opts.DurableTimeout)
	defer cancel()
	unlock, err := s.uploads.lock(ctx, id)
	if err != nil {
		s.opts.Log.Warn("files: forget upload", "upload", id, "err", err)
		return
	}
	defer unlock()
	rec, ok, err := s.getUpload(id)
	if err == nil && ok {
		err = s.dropUpload(ctx, rec)
	}
	if err != nil {
		s.opts.Log.Warn("files: forget upload", "upload", id, "err", err)
	}
}

// Janitor removes uploads without activity for UploadTTL (and their
// temporary files), once at the start and then hourly, until ctx ends.
func (s *Service) Janitor(ctx context.Context) {
	t := time.NewTicker(janitorInterval)
	defer t.Stop()
	for {
		s.sweep(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// sweep removes expired uploads and orphaned files in UploadsDir.
func (s *Service) sweep(ctx context.Context) {
	now := s.opts.Now()
	var expired []string
	known := map[string]bool{}
	err := s.st.ListUploads(func(u *store.Upload) bool {
		if now.Sub(u.LastActivity) > s.opts.UploadTTL {
			expired = append(expired, u.ID)
		} else if u.TempPath != "" {
			known[u.TempPath] = true
		}
		return true
	})
	if err != nil {
		s.opts.Log.Warn("files: list uploads", "err", err)
		return
	}
	for _, id := range expired {
		if err := s.expire(ctx, id, now); err != nil {
			s.opts.Log.Warn("files: remove expired upload", "upload", id, "err", err)
		}
	}
	entries, err := os.ReadDir(s.opts.Layout.UploadsDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		p := filepath.Join(s.opts.Layout.UploadsDir, e.Name())
		if known[p] {
			continue
		}
		if _, ok, _ := s.st.GetUpload(e.Name()); ok {
			continue
		}
		if fi, err := e.Info(); err == nil && now.Sub(fi.ModTime()) > s.opts.UploadTTL {
			_ = os.RemoveAll(p)
		}
	}
}

// expire removes upload id if it is still expired under its lock.
func (s *Service) expire(ctx context.Context, id string, now time.Time) error {
	unlock, err := s.uploads.lock(ctx, id)
	if err != nil {
		return err
	}
	defer unlock()
	rec, ok, err := s.getUpload(id)
	if err != nil || !ok || now.Sub(rec.LastActivity) <= s.opts.UploadTTL {
		return err
	}
	return s.dropUpload(ctx, rec)
}

// keyedMutex is a set of mutexes by key that waits with a context. The
// zero value is ready to use.
type keyedMutex struct {
	mu sync.Mutex
	m  map[string]*keyedEntry
}

type keyedEntry struct {
	sem  chan struct{}
	refs int
}

// lock takes the mutex of key, or fails when ctx ends first.
func (k *keyedMutex) lock(ctx context.Context, key string) (func(), error) {
	k.mu.Lock()
	if k.m == nil {
		k.m = map[string]*keyedEntry{}
	}
	e := k.m[key]
	if e == nil {
		e = &keyedEntry{sem: make(chan struct{}, 1)}
		k.m[key] = e
	}
	e.refs++
	k.mu.Unlock()
	release := func() {
		k.mu.Lock()
		e.refs--
		if e.refs == 0 {
			delete(k.m, key)
		}
		k.mu.Unlock()
	}
	select {
	case e.sem <- struct{}{}:
		return func() { <-e.sem; release() }, nil
	case <-ctx.Done():
		release()
		return nil, ctx.Err()
	}
}
