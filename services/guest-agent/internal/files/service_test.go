package files

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/proto/umiak/agent/v1/agentv1connect"
	"github.com/belov38/umiak/libs/tunnel/rpcconv"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
)

// wantCode checks the Connect code and ErrorDetail code of err.
func wantCode(t *testing.T, err error, code connect.Code, detail string) {
	t.Helper()
	var cerr *connect.Error
	if !errors.As(err, &cerr) {
		t.Fatalf("err = %v, want %v %s", err, code, detail)
	}
	if cerr.Code() != code {
		t.Fatalf("code = %v, want %v (%v)", cerr.Code(), code, cerr)
	}
	if d, ok := rpcconv.Detail(cerr); !ok || d.GetCode() != detail {
		t.Fatalf("detail = %v, want %s (%v)", d, detail, cerr)
	}
}

func TestFilesystemRPCs(t *testing.T) {
	h := newHarness(t)
	ctx := h.ctx()

	// Stat and no_follow.
	f := h.writeFile("s/file.txt", []byte("hello"), 0o640)
	link := h.path("s", "link")
	if err := os.Symlink("file.txt", link); err != nil {
		t.Fatal(err)
	}
	res, err := h.fs.Stat(ctx, connect.NewRequest(&agentv1.StatRequest{Path: link}))
	if err != nil {
		t.Fatal(err)
	}
	if fi := res.Msg.GetInfo(); fi.GetType() != agentv1.FileType_FILE_TYPE_FILE || fi.GetSize() != 5 || fi.GetMode() != infoMode("link", false, 0o640) || fi.GetPath() != link {
		t.Fatalf("Stat follow = %v", fi)
	}
	res, err = h.fs.Stat(ctx, connect.NewRequest(&agentv1.StatRequest{Path: link, NoFollow: true}))
	if err != nil {
		t.Fatal(err)
	}
	if fi := res.Msg.GetInfo(); fi.GetType() != agentv1.FileType_FILE_TYPE_SYMLINK || fi.GetSymlinkTarget() != "file.txt" || fi.GetName() != "link" {
		t.Fatalf("Stat no_follow = %v", fi)
	}
	if fi := res.Msg.GetInfo(); fi.GetOwner() == "" || fi.GetUid() != h.user.UID || fi.GetMtime() == nil {
		t.Fatalf("Stat owner/mtime = %v", fi)
	}
	_, err = h.fs.Stat(ctx, connect.NewRequest(&agentv1.StatRequest{Path: h.path("missing")}))
	wantCode(t, err, connect.CodeNotFound, errs.PathNotFound)

	// List depth 2 with paging.
	tree := h.path("tree")
	for _, rel := range []string{"a/1", "a/2", "a/deep/x", "b", "c/3", ".hidden"} {
		h.writeFile(filepath.Join("tree", rel), []byte(rel), 0o644)
	}
	// Depth 2: everything except a/deep/x.
	want := []string{".hidden", "a", "a/1", "a/2", "a/deep", "b", "c", "c/3"}
	var got []string
	token := ""
	pages := 0
	for {
		lres, err := h.fs.List(ctx, connect.NewRequest(&agentv1.FilesystemListRequest{Path: tree, Depth: 2, PageSize: 3, PageToken: token}))
		if err != nil {
			t.Fatal(err)
		}
		pages++
		if len(lres.Msg.GetEntries()) > 3 {
			t.Fatalf("page of %d entries", len(lres.Msg.GetEntries()))
		}
		for _, e := range lres.Msg.GetEntries() {
			rel, _ := filepath.Rel(tree, e.GetPath())
			got = append(got, filepath.ToSlash(rel))
		}
		token = lres.Msg.GetNextPageToken()
		if token == "" {
			break
		}
		if pages > 10 {
			t.Fatal("paging does not end")
		}
	}
	if !slices.Equal(got, want) || pages != 3 {
		t.Fatalf("List = %v in %d pages, want %v in 3", got, pages, want)
	}
	lres, err := h.fs.List(ctx, connect.NewRequest(&agentv1.FilesystemListRequest{Path: tree, IncludeHidden: proto.Bool(false)}))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range lres.Msg.GetEntries() {
		names = append(names, e.GetName())
	}
	if !slices.Equal(names, []string{"a", "b", "c"}) {
		t.Fatalf("List depth 1 without hidden = %v", names)
	}
	_, err = h.fs.List(ctx, connect.NewRequest(&agentv1.FilesystemListRequest{Path: tree, Depth: 9}))
	wantCode(t, err, connect.CodeInvalidArgument, errs.InvalidArgument)
	_, err = h.fs.List(ctx, connect.NewRequest(&agentv1.FilesystemListRequest{Path: f}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.NotDirectory)

	// MakeDir.
	dir := h.path("mk", "a", "b")
	mres, err := h.fs.MakeDir(ctx, connect.NewRequest(&agentv1.MakeDirRequest{Path: dir, Parents: true, Mode: proto.Uint32(0o750)}))
	if err != nil {
		t.Fatal(err)
	}
	if !mres.Msg.GetCreated() || mres.Msg.GetInfo().GetType() != agentv1.FileType_FILE_TYPE_DIR || mres.Msg.GetInfo().GetMode() != infoMode("b", true, 0o750) {
		t.Fatalf("MakeDir = %v", mres.Msg)
	}
	mres, err = h.fs.MakeDir(ctx, connect.NewRequest(&agentv1.MakeDirRequest{Path: dir}))
	if err != nil {
		t.Fatal(err)
	}
	if mres.Msg.GetCreated() {
		t.Fatal("MakeDir of an existing directory: created = true")
	}
	_, err = h.fs.MakeDir(ctx, connect.NewRequest(&agentv1.MakeDirRequest{Path: h.path("nope", "x")}))
	wantCode(t, err, connect.CodeNotFound, errs.PathNotFound)
	_, err = h.fs.MakeDir(ctx, connect.NewRequest(&agentv1.MakeDirRequest{Path: f}))
	wantCode(t, err, connect.CodeAlreadyExists, errs.AlreadyExists)

	// Move.
	src := h.writeFile("mv/src", []byte("src"), 0o644)
	dst := h.writeFile("mv/dst", []byte("dst"), 0o644)
	_, err = h.fs.Move(ctx, connect.NewRequest(&agentv1.MoveRequest{Src: src, Dst: dst}))
	wantCode(t, err, connect.CodeAlreadyExists, errs.AlreadyExists)
	mvres, err := h.fs.Move(ctx, connect.NewRequest(&agentv1.MoveRequest{Src: src, Dst: dst, Overwrite: true}))
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "src" || mvres.Msg.GetInfo().GetPath() != dst {
		t.Fatalf("Move: dst = %q, info %v", b, mvres.Msg.GetInfo())
	}
	if _, err := os.Lstat(src); !os.IsNotExist(err) {
		t.Fatalf("src still exists: %v", err)
	}
	_, err = h.fs.Move(ctx, connect.NewRequest(&agentv1.MoveRequest{Src: src, Dst: h.path("mv", "z")}))
	wantCode(t, err, connect.CodeNotFound, errs.PathNotFound)

	// Remove.
	rres, err := h.fs.Remove(ctx, connect.NewRequest(&agentv1.FilesystemRemoveRequest{Path: h.path("missing")}))
	if err != nil {
		t.Fatal(err)
	}
	if rres.Msg.GetExisted() {
		t.Fatal("Remove missing: existed = true")
	}
	outside := h.writeFile("outside/keep", []byte("keep"), 0o644)
	rmdir := h.path("rm")
	h.writeFile("rm/x/y", []byte("y"), 0o644)
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(rmdir, "out")); err != nil {
		t.Fatal(err)
	}
	_, err = h.fs.Remove(ctx, connect.NewRequest(&agentv1.FilesystemRemoveRequest{Path: rmdir}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.FailedPrecondition)
	rres, err = h.fs.Remove(ctx, connect.NewRequest(&agentv1.FilesystemRemoveRequest{Path: rmdir, Recursive: true}))
	if err != nil {
		t.Fatal(err)
	}
	if !rres.Msg.GetExisted() {
		t.Fatal("Remove: existed = false")
	}
	if _, err := os.Lstat(rmdir); !os.IsNotExist(err) {
		t.Fatalf("rm dir kept: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("recursive remove followed a symlink: %v", err)
	}

	// Chmod recursive does not follow symlinks.
	cdir := h.path("ch")
	h.writeFile("ch/a/f", []byte("f"), 0o644)
	ext := h.writeFile("chext/f", []byte("e"), 0o644)
	if err := os.Symlink(filepath.Dir(ext), filepath.Join(cdir, "l")); err != nil {
		t.Fatal(err)
	}
	cres, err := h.fs.Chmod(ctx, connect.NewRequest(&agentv1.ChmodRequest{Path: cdir, Mode: proto.Uint32(0o700), Owner: h.user.Name, Recursive: true}))
	if err != nil {
		t.Fatal(err)
	}
	if cres.Msg.GetInfo().GetMode() != infoMode("ch", true, 0o700) {
		t.Fatalf("Chmod info = %v", cres.Msg.GetInfo())
	}
	for _, p := range []string{cdir, filepath.Join(cdir, "a"), filepath.Join(cdir, "a", "f")} {
		st, err := os.Stat(p)
		if err != nil || st.Mode().Perm() != statPerm(st.IsDir(), 0o700) {
			t.Fatalf("%s mode = %v, %v", p, st.Mode(), err)
		}
	}
	if st, _ := os.Stat(ext); st.Mode().Perm() != statPerm(false, 0o644) {
		t.Fatalf("Chmod followed a symlink: %v", st.Mode())
	}
	_, err = h.fs.Chmod(ctx, connect.NewRequest(&agentv1.ChmodRequest{Path: cdir, Owner: "no-such-user-umiak-test"}))
	wantCode(t, err, connect.CodeInvalidArgument, errs.UserNotFound)

	// Mutations need Umiak-Request-Id (reqcache interceptors from the wiring).
	_, err = agentv1connect.NewFilesystemClient(h.srv.Client(), h.srv.URL).MakeDir(ctx, connect.NewRequest(&agentv1.MakeDirRequest{Path: h.path("noid")}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("MakeDir without request id: %v", err)
	}
}
