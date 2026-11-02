// Package files is the file API of the agent (spec section 11): the
// umiak.agent.v1.Filesystem Connect service for small operations and the plain
// HTTP /files endpoints for file bodies, resumable uploads and directory
// archives.
//
// Every operation runs as root. Paths are resolved for the request user
// (Resolve) and new files and directories get the requested owner or the
// request user. There are no path restrictions: the trust boundary is the
// VM. Mutations wait for the thaw while the agent's own filesystem freeze is
// active and then fail with unavailable/quiesced; reads work during a freeze
// (spec 14.4).
package files

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/proto/umiak/agent/v1/agentv1connect"

	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/errs"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
	"github.com/belov38/umiak/services/guest-agent/internal/process"
	"github.com/belov38/umiak/services/guest-agent/internal/store"
)

// Defaults of Options.
const (
	DefaultUploadTTL         = 24 * time.Hour
	DefaultMaxChunk          = 8 << 20
	DefaultArchiveMaxEntries = 200000
	DefaultArchiveMaxBytes   = 16 << 30
	DefaultArchiveMaxPath    = 4096
	DefaultDurableTimeout    = 30 * time.Second
)

// List limits (spec 11.4).
const (
	maxListDepth    = 8
	defaultPageSize = 1000
	maxPageSize     = 10000
)

// maxMessageBytes bounds Connect messages in both directions.
const maxMessageBytes = 16 << 20

// defaultDirMode is the mode of directories created without an explicit one.
const defaultDirMode fs.FileMode = 0o755

// Options configures a Service. Zero values select the defaults.
type Options struct {
	// Store holds the upload records.
	Store *store.Store
	// Layout locates UploadsDir and StateDir.
	Layout paths.Layout
	// DefaultUser resolves paths when the request names no user. Default
	// config.Defaults().DefaultUser.
	DefaultUser string
	// Now is the clock. Default time.Now.
	Now func() time.Time
	// UploadTTL removes uploads without activity (and the stored results
	// of committed ones) after this long.
	UploadTTL time.Duration
	// MaxChunk is the largest upload chunk.
	MaxChunk int64
	// ArchiveMaxEntries, ArchiveMaxBytes and ArchiveMaxPath bound an
	// archive upload: entries, unpacked bytes and the length of an entry
	// path.
	ArchiveMaxEntries int
	ArchiveMaxBytes   int64
	ArchiveMaxPath    int
	// DurableTimeout bounds the wait for a thaw and for a durable write.
	DurableTimeout time.Duration
	// HandlerOptions are added to the Connect handler; the wiring passes
	// reqcache.Interceptors (created once and shared by all services).
	HandlerOptions []connect.HandlerOption
	// Log receives janitor failures. Default slog.Default().
	Log *slog.Logger
}

func (o *Options) setDefaults() error {
	if o.Store == nil {
		return errors.New("files: Options.Store is required")
	}
	if o.DefaultUser == "" {
		o.DefaultUser = config.Defaults().DefaultUser
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.UploadTTL <= 0 {
		o.UploadTTL = DefaultUploadTTL
	}
	if o.MaxChunk <= 0 {
		o.MaxChunk = DefaultMaxChunk
	}
	if o.ArchiveMaxEntries <= 0 {
		o.ArchiveMaxEntries = DefaultArchiveMaxEntries
	}
	if o.ArchiveMaxBytes <= 0 {
		o.ArchiveMaxBytes = DefaultArchiveMaxBytes
	}
	if o.ArchiveMaxPath <= 0 {
		o.ArchiveMaxPath = DefaultArchiveMaxPath
	}
	if o.DurableTimeout <= 0 {
		o.DurableTimeout = DefaultDurableTimeout
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return nil
}

// Service implements the Filesystem service and the /files endpoints.
type Service struct {
	opts    Options
	st      *store.Store
	uploads keyedMutex

	// Test hooks: after an upload is moved to its target, and after the
	// header of an archived file is written.
	testHookAfterPlace  func()
	testHookAfterHeader func(name string)
}

// New returns a Service.
func New(opts Options) (*Service, error) {
	if err := opts.setDefaults(); err != nil {
		return nil, err
	}
	return &Service{opts: opts, st: opts.Store}, nil
}

// ConnectHandler returns the path and the handler of the
// umiak.agent.v1.Filesystem service: Options.HandlerOptions plus 16 MiB
// message limits and no gzip, so responses are never compressed.
func (s *Service) ConnectHandler() (string, http.Handler) {
	opts := slices.Concat(s.opts.HandlerOptions, []connect.HandlerOption{
		connect.WithReadMaxBytes(maxMessageBytes),
		connect.WithSendMaxBytes(maxMessageBytes),
		connect.WithCompression("gzip", nil, nil),
	})
	return agentv1connect.NewFilesystemHandler(rpc{s: s}, opts...)
}

// user resolves the request user name (empty: DefaultUser).
func (s *Service) user(name string) (*process.User, error) {
	if name == "" {
		name = s.opts.DefaultUser
	}
	return lookupUser(name)
}

// resolve resolves the request user and a path for it.
func (s *Service) resolve(userName, p string) (*process.User, string, error) {
	u, err := s.user(userName)
	if err != nil {
		return nil, "", err
	}
	abs, err := Resolve(p, u)
	if err != nil {
		return nil, "", err
	}
	return u, abs, nil
}

// quiesced is the error of a mutation that met the agent's own freeze.
func quiesced() error {
	return errs.New(connect.CodeUnavailable, errs.Quiesced, "the filesystem is quiesced")
}

// waitThaw returns at once unless the agent's own freeze is active; then it
// waits for the thaw within DurableTimeout and the call's context and fails
// with quiesced. Mutations call it before touching the disk, so they never
// block inside the kernel on a frozen filesystem.
func (s *Service) waitThaw(ctx context.Context) error {
	thawed := s.st.Thawed()
	select {
	case <-thawed:
		return nil
	default:
	}
	ctx, cancel := s.durableCtx(ctx)
	defer cancel()
	select {
	case <-thawed:
		return nil
	case <-ctx.Done():
		return quiesced()
	}
}

// durableCtx bounds a wait made for a call by DurableTimeout and ends it a
// little before the call's own deadline, so the caller gets quiesced rather
// than a timeout.
func (s *Service) durableCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := s.opts.DurableTimeout
	if dl, ok := ctx.Deadline(); ok {
		budget := time.Until(dl)
		timeout = min(timeout, budget-min(budget/10, time.Second))
	}
	return context.WithTimeout(ctx, timeout)
}

// storeError maps a failed durable write.
func storeError(err error) error {
	switch {
	case errors.Is(err, store.ErrFrozen):
		return quiesced()
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	default:
		return errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
}

// fsError maps a filesystem error (spec 11.1); a non-empty directory is a
// failed precondition.
func fsError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, syscall.ENOTEMPTY) {
		return errs.New(connect.CodeFailedPrecondition, errs.FailedPrecondition, err.Error())
	}
	return errs.FromErrno(err)
}

// invalidArg is an invalid_argument error with the generic detail.
func invalidArg(format string, args ...any) error {
	return errs.Newf(connect.CodeInvalidArgument, errs.InvalidArgument, format, args...)
}

// rpc adapts the Service to agentv1connect.FilesystemHandler.
type rpc struct{ s *Service }

var _ agentv1connect.FilesystemHandler = rpc{}

// Stat implements agentv1connect.FilesystemHandler.
func (r rpc) Stat(_ context.Context, req *connect.Request[agentv1.StatRequest]) (*connect.Response[agentv1.StatResponse], error) {
	_, p, err := r.s.resolve(req.Msg.GetUser(), req.Msg.GetPath())
	if err != nil {
		return nil, err
	}
	info, err := statInfo(p, !req.Msg.GetNoFollow(), newNames())
	if err != nil {
		return nil, fsError(err)
	}
	return connect.NewResponse(&agentv1.StatResponse{Info: info}), nil
}

// List implements agentv1connect.FilesystemHandler.
func (r rpc) List(_ context.Context, req *connect.Request[agentv1.FilesystemListRequest]) (*connect.Response[agentv1.FilesystemListResponse], error) {
	res, err := r.s.list(req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

// MakeDir implements agentv1connect.FilesystemHandler.
func (r rpc) MakeDir(ctx context.Context, req *connect.Request[agentv1.MakeDirRequest]) (*connect.Response[agentv1.MakeDirResponse], error) {
	res, err := r.s.makeDir(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(res), nil
}

// Move implements agentv1connect.FilesystemHandler.
func (r rpc) Move(ctx context.Context, req *connect.Request[agentv1.MoveRequest]) (*connect.Response[agentv1.MoveResponse], error) {
	info, err := r.s.move(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.MoveResponse{Info: info}), nil
}

// Chmod implements agentv1connect.FilesystemHandler.
func (r rpc) Chmod(ctx context.Context, req *connect.Request[agentv1.ChmodRequest]) (*connect.Response[agentv1.ChmodResponse], error) {
	info, err := r.s.chmod(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.ChmodResponse{Info: info}), nil
}

// Remove implements agentv1connect.FilesystemHandler.
func (r rpc) Remove(ctx context.Context, req *connect.Request[agentv1.FilesystemRemoveRequest]) (*connect.Response[agentv1.FilesystemRemoveResponse], error) {
	existed, err := r.s.remove(ctx, req.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&agentv1.FilesystemRemoveResponse{Existed: existed}), nil
}

// list returns one page of a directory listing. Entries are ordered by path
// component by component, so the subtree of a directory follows it
// directly; the page token is the path of the last entry of a page.
func (s *Service) list(req *agentv1.FilesystemListRequest) (*agentv1.FilesystemListResponse, error) {
	_, dir, err := s.resolve(req.GetUser(), req.GetPath())
	if err != nil {
		return nil, err
	}
	depth := int(req.GetDepth())
	if depth == 0 {
		depth = 1
	}
	if depth > maxListDepth {
		return nil, invalidArg("depth %d is above %d", depth, maxListDepth)
	}
	pageSize := int(req.GetPageSize())
	if pageSize == 0 {
		pageSize = defaultPageSize
	}
	pageSize = min(pageSize, maxPageSize)
	l := &lister{
		depth:  depth,
		hidden: req.IncludeHidden == nil || req.GetIncludeHidden(),
		limit:  pageSize + 1,
		names:  newNames(),
	}
	if tok := req.GetPageToken(); tok != "" {
		rel, err := filepath.Rel(dir, filepath.Clean(tok))
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, invalidArg("page_token %q is not under %s", tok, dir)
		}
		l.after = strings.Split(rel, string(filepath.Separator))
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return nil, fsError(err)
	}
	if !fi.IsDir() {
		return nil, errs.Newf(connect.CodeFailedPrecondition, errs.NotDirectory, "%s is not a directory", dir)
	}
	if err := l.walk(dir, nil, 1); err != nil {
		return nil, fsError(err)
	}
	res := &agentv1.FilesystemListResponse{Entries: l.out}
	if len(l.out) > pageSize {
		res.Entries = l.out[:pageSize]
		res.NextPageToken = res.Entries[pageSize-1].GetPath()
	}
	return res, nil
}

// lister walks a directory tree in path order.
type lister struct {
	depth  int
	hidden bool
	limit  int      // entries to collect: page size + 1
	after  []string // components of the page token, relative to the root
	names  *names
	out    []*agentv1.FileInfo
}

// walk lists abs (components rel below the root) at level 1..depth. It
// returns errors only for the root directory; unreadable subdirectories are
// skipped.
func (l *lister) walk(abs string, rel []string, level int) error {
	entries, err := os.ReadDir(abs)
	if err != nil {
		if level == 1 {
			return err
		}
		return nil
	}
	for _, e := range entries {
		name := e.Name()
		if !l.hidden && strings.HasPrefix(name, ".") {
			continue
		}
		childRel := slices.Concat(rel, []string{name})
		emit := l.after == nil || compareComponents(childRel, l.after) > 0
		// Before the token and not on its path: the whole subtree is before
		// the token too.
		if !emit && !isPrefix(childRel, l.after) {
			continue
		}
		p := filepath.Join(abs, name)
		if emit {
			info, err := statInfo(p, false, l.names)
			if err != nil {
				continue // removed while listing
			}
			l.out = append(l.out, info)
			if len(l.out) >= l.limit {
				return nil
			}
		}
		if e.IsDir() && level < l.depth {
			if err := l.walk(p, childRel, level+1); err != nil {
				return err
			}
			if len(l.out) >= l.limit {
				return nil
			}
		}
	}
	return nil
}

// compareComponents orders paths component by component.
func compareComponents(a, b []string) int {
	for i := range min(len(a), len(b)) {
		if c := strings.Compare(a[i], b[i]); c != 0 {
			return c
		}
	}
	return len(a) - len(b)
}

// isPrefix reports whether a is b or an ancestor of b.
func isPrefix(a, b []string) bool {
	return len(a) <= len(b) && slices.Equal(a, b[:len(a)])
}

// makeDir creates a directory; an existing one is created=false.
func (s *Service) makeDir(ctx context.Context, req *agentv1.MakeDirRequest) (*agentv1.MakeDirResponse, error) {
	u, dir, err := s.resolve(req.GetUser(), req.GetPath())
	if err != nil {
		return nil, err
	}
	o, err := resolveOwner(req.GetOwner(), u)
	if err != nil {
		return nil, err
	}
	mode := defaultDirMode
	if req.Mode != nil {
		mode = toFileMode(req.GetMode())
	}
	if err := s.waitThaw(ctx); err != nil {
		return nil, err
	}
	names := newNames()
	existing := func() (*agentv1.MakeDirResponse, error) {
		info, err := statInfo(dir, true, names)
		if err != nil {
			return nil, fsError(err)
		}
		if info.GetType() != agentv1.FileType_FILE_TYPE_DIR {
			return nil, errs.Newf(connect.CodeAlreadyExists, errs.AlreadyExists, "%s exists and is not a directory", dir)
		}
		return &agentv1.MakeDirResponse{Info: info}, nil
	}
	if _, err := os.Lstat(dir); err == nil {
		return existing()
	}
	if req.GetParents() {
		if err := mkdirAll(filepath.Dir(dir), defaultDirMode, o); err != nil {
			return nil, fsError(err)
		}
	}
	if err := os.Mkdir(dir, mode); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return existing()
		}
		return nil, fsError(err)
	}
	if err := os.Chmod(dir, mode); err != nil {
		return nil, fsError(err)
	}
	if err := lchown(dir, o); err != nil {
		return nil, fsError(err)
	}
	info, err := statInfo(dir, true, names)
	if err != nil {
		return nil, fsError(err)
	}
	return &agentv1.MakeDirResponse{Info: info, Created: true}, nil
}

// move renames src to dst. Across filesystems a file (or symlink) is copied
// and removed; a directory is cross_device.
func (s *Service) move(ctx context.Context, req *agentv1.MoveRequest) (*agentv1.FileInfo, error) {
	u, src, err := s.resolve(req.GetUser(), req.GetSrc())
	if err != nil {
		return nil, err
	}
	dst, err := Resolve(req.GetDst(), u)
	if err != nil {
		return nil, err
	}
	if err := s.waitThaw(ctx); err != nil {
		return nil, err
	}
	sfi, err := os.Lstat(src)
	if err != nil {
		return nil, fsError(err)
	}
	if req.GetOverwrite() {
		err = replaceFile(src, dst)
	} else {
		err = renameNoReplace(src, dst)
	}
	switch {
	case err == nil:
	case !req.GetOverwrite() && errors.Is(err, fs.ErrExist):
		return nil, errs.Newf(connect.CodeAlreadyExists, errs.AlreadyExists, "%s already exists", dst)
	case isCrossDevice(err):
		if sfi.IsDir() {
			return nil, errs.Newf(connect.CodeFailedPrecondition, errs.CrossDevice, "cannot move directory %s across filesystems", src)
		}
		if err := copyAcross(src, dst, sfi, req.GetOverwrite()); err != nil {
			return nil, err
		}
		if err := os.Remove(src); err != nil {
			return nil, fsError(err)
		}
	case sfi.IsDir() && isNotEmpty(err):
		return nil, errs.Newf(connect.CodeAlreadyExists, errs.AlreadyExists, "%s is a non-empty directory", dst)
	default:
		return nil, fsError(err)
	}
	info, err := statInfo(dst, false, newNames())
	if err != nil {
		return nil, fsError(err)
	}
	return info, nil
}

// copyAcross copies the file or symlink src to dst on another filesystem
// through a temporary file next to dst, keeping mode, owner and mtime.
func copyAcross(src, dst string, sfi fs.FileInfo, overwrite bool) error {
	dir := filepath.Dir(dst)
	sys := sysOf(sfi)
	o := owner{uid: int(sys.uid), gid: int(sys.gid)}
	switch {
	case sfi.Mode()&fs.ModeSymlink != 0:
		target, err := os.Readlink(src)
		if err != nil {
			return fsError(err)
		}
		tmp := filepath.Join(dir, ".umiak-tmp-"+randomSuffix())
		if err := os.Symlink(target, tmp); err != nil {
			return fsError(err)
		}
		if err := lchown(tmp, o); err != nil {
			_ = os.Remove(tmp)
			return fsError(err)
		}
		return placeTemp(tmp, dst, overwrite)
	case sfi.Mode().IsRegular():
		in, err := os.Open(src)
		if err != nil {
			return fsError(err)
		}
		defer func() { _ = in.Close() }()
		tmp, err := writeTemp(dir, in, sfi.Mode()&(fs.ModePerm|fs.ModeSetuid|fs.ModeSetgid|fs.ModeSticky), o)
		if err != nil {
			return err
		}
		if err := os.Chtimes(tmp, time.Time{}, sfi.ModTime()); err != nil {
			_ = os.Remove(tmp)
			return fsError(err)
		}
		return placeTemp(tmp, dst, overwrite)
	default:
		return errs.Newf(connect.CodeFailedPrecondition, errs.CrossDevice, "cannot move special file %s across filesystems", src)
	}
}

// chmod changes mode and ownership. A symlink given as the path is
// followed; a recursive walk never follows symlinks (it changes the owner
// of a link itself and leaves its mode alone).
func (s *Service) chmod(ctx context.Context, req *agentv1.ChmodRequest) (*agentv1.FileInfo, error) {
	_, p, err := s.resolve(req.GetUser(), req.GetPath())
	if err != nil {
		return nil, err
	}
	o := owner{uid: -1, gid: -1}
	if req.GetOwner() != "" {
		name, group, hasGroup := strings.Cut(req.GetOwner(), ":")
		u, err := lookupUser(name)
		if err != nil {
			return nil, err
		}
		o.uid, o.account = int(u.UID), accountOf(u)
		if hasGroup {
			gid, err := lookupGroup(group)
			if err != nil {
				return nil, err
			}
			o.gid = int(gid)
		}
	}
	if req.GetGroup() != "" {
		gid, err := lookupGroup(req.GetGroup())
		if err != nil {
			return nil, err
		}
		o.gid = int(gid)
	}
	if err := s.waitThaw(ctx); err != nil {
		return nil, err
	}
	target, err := filepath.EvalSymlinks(p)
	if err != nil {
		return nil, fsError(err)
	}
	apply := func(path string, symlink bool) error {
		if req.Mode != nil && !symlink {
			if err := os.Chmod(path, toFileMode(req.GetMode())); err != nil {
				return err
			}
		}
		if o.uid != -1 || o.gid != -1 {
			return lchown(path, o)
		}
		return nil
	}
	if req.GetRecursive() {
		err = filepath.WalkDir(target, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			return apply(path, d.Type()&fs.ModeSymlink != 0)
		})
	} else {
		err = apply(target, false)
	}
	if err != nil {
		return nil, fsError(err)
	}
	info, err := statInfo(p, true, newNames())
	if err != nil {
		return nil, fsError(err)
	}
	return info, nil
}

// remove deletes a path; a missing one is existed=false. A recursive removal
// does not follow symlinks.
func (s *Service) remove(ctx context.Context, req *agentv1.FilesystemRemoveRequest) (bool, error) {
	_, p, err := s.resolve(req.GetUser(), req.GetPath())
	if err != nil {
		return false, err
	}
	if err := s.waitThaw(ctx); err != nil {
		return false, err
	}
	if _, err := os.Lstat(p); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, fsError(err)
	}
	if req.GetRecursive() {
		err = os.RemoveAll(p)
	} else {
		err = os.Remove(p)
	}
	if err != nil {
		if errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST) {
			return false, errs.Newf(connect.CodeFailedPrecondition, errs.FailedPrecondition, "directory %s is not empty", p)
		}
		return false, fsError(err)
	}
	return true, nil
}
