package files

import (
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"golang.org/x/sys/windows"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/umiak/libs/proto/umiak/agent/v1"
	"github.com/belov38/umiak/libs/tunnel/rpcconv"

	"github.com/belov38/umiak/services/guest-agent/internal/errs"
	"github.com/belov38/umiak/services/guest-agent/internal/process"
)

// holdOpen opens path for reading with the given share mode until the test
// ends or the returned function runs.
func holdOpen(t *testing.T, path string, share uint32) (release func()) {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, share, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	closed := false
	release = func() {
		if !closed {
			closed = true
			_ = windows.CloseHandle(h)
		}
	}
	t.Cleanup(release)
	return release
}

// wantRetryable checks that a Connect error is retryable.
func wantRetryable(t *testing.T, err error) {
	t.Helper()
	var cerr *connect.Error
	if !errors.As(err, &cerr) {
		t.Fatalf("err = %v, want a Connect error", err)
	}
	if d, ok := rpcconv.Detail(cerr); !ok || !d.GetRetryable() {
		t.Fatalf("err %v is not retryable", err)
	}
}

func TestWriteWhileOpenWithoutShareIsFileInUse(t *testing.T) {
	h := newHarness(t)
	ctx := h.ctx()
	p := h.writeFile("busy/f.txt", []byte("old"), 0o644)
	other := h.writeFile("busy/other.txt", []byte("other"), 0o644)
	release := holdOpen(t, p, windows.FILE_SHARE_READ)

	res := h.do(http.MethodPut, "/files", q("path", p), strings.NewReader("new"), nil)
	if e := wantError(t, res, http.StatusBadRequest, errs.FileInUse); !e.Retryable {
		t.Fatal("file_in_use of a write is not retryable")
	}
	entries, err := os.ReadDir(filepath.Dir(p))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("a failed write left %d entries, want 2", len(entries))
	}

	_, err = h.fs.Move(ctx, connect.NewRequest(&agentv1.MoveRequest{Src: other, Dst: p, Overwrite: true}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.FileInUse)
	wantRetryable(t, err)
	_, err = h.fs.Move(ctx, connect.NewRequest(&agentv1.MoveRequest{Src: p, Dst: h.path("busy", "moved.txt")}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.FileInUse)
	_, err = h.fs.Remove(ctx, connect.NewRequest(&agentv1.FilesystemRemoveRequest{Path: p}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.FileInUse)
	_, err = h.fs.Remove(ctx, connect.NewRequest(&agentv1.FilesystemRemoveRequest{Path: filepath.Dir(p), Recursive: true}))
	wantCode(t, err, connect.CodeFailedPrecondition, errs.FileInUse)

	release()
	wantStatus(t, h.do(http.MethodPut, "/files", q("path", p), strings.NewReader("new"), nil), http.StatusOK)
	if b, _ := os.ReadFile(p); string(b) != "new" {
		t.Fatalf("content %q after the holder closed", b)
	}

	// A holder that shares delete does not block the replace.
	holdOpen(t, p, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE)
	wantStatus(t, h.do(http.MethodPut, "/files", q("path", p), strings.NewReader("newer"), nil), http.StatusOK)
	if b, _ := os.ReadFile(p); string(b) != "newer" {
		t.Fatalf("content %q with a FILE_SHARE_DELETE holder", b)
	}
}

func TestWriteReplacesReadOnlyFile(t *testing.T) {
	h := newHarness(t)
	p := h.writeFile("ro.txt", []byte("old"), 0o644)
	if err := os.Chmod(p, 0o444); err != nil {
		t.Fatal(err)
	}
	fi := fileInfo(t, wantStatus(t, h.do(http.MethodPut, "/files", q("path", p), strings.NewReader("new"), nil), http.StatusOK))
	if fi.GetMode() != 0o644 {
		t.Fatalf("mode %o, want 644", fi.GetMode())
	}
	if b, _ := os.ReadFile(p); string(b) != "new" {
		t.Fatalf("content %q", b)
	}
	fi = fileInfo(t, wantStatus(t, h.do(http.MethodPut, "/files", q("path", p, "mode", "444"), strings.NewReader("ro"), nil), http.StatusOK))
	if fi.GetMode() != 0o444 {
		t.Fatalf("mode %o, want 444", fi.GetMode())
	}
}

// junction creates a directory junction link -> target.
func junction(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.CommandContext(t.Context(), "cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J %s %s: %v: %s", link, target, err, out)
	}
}

func TestRecursiveRemoveDoesNotFollowJunction(t *testing.T) {
	h := newHarness(t)
	ctx := h.ctx()
	keep := h.writeFile("outside/keep", []byte("keep"), 0o644)
	h.writeFile("tree/a/f", []byte("f"), 0o644)
	tree := h.path("tree")
	j := h.path("tree", "j")
	junction(t, j, h.path("outside"))
	junction(t, h.path("tree", "a", "loop"), tree)

	sres, err := h.fs.Stat(ctx, connect.NewRequest(&agentv1.StatRequest{Path: j, NoFollow: true}))
	if err != nil {
		t.Fatal(err)
	}
	if fi := sres.Msg.GetInfo(); fi.GetType() != agentv1.FileType_FILE_TYPE_SYMLINK ||
		!strings.EqualFold(filepath.Clean(fi.GetSymlinkTarget()), h.path("outside")) || fi.GetMode() != 0o777 {
		t.Fatalf("junction info %v", fi)
	}
	lres, err := h.fs.List(ctx, connect.NewRequest(&agentv1.FilesystemListRequest{Path: tree, Depth: 8}))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range lres.Msg.GetEntries() {
		rel, _ := filepath.Rel(tree, e.GetPath())
		got = append(got, rel+":"+e.GetType().String())
	}
	want := []string{
		`a:FILE_TYPE_DIR`, `a\f:FILE_TYPE_FILE`, `a\loop:FILE_TYPE_SYMLINK`, `j:FILE_TYPE_SYMLINK`,
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("List = %v, want %v", got, want)
	}

	// A recursive chmod stays out of the junctions too.
	if _, err := h.fs.Chmod(ctx, connect.NewRequest(&agentv1.ChmodRequest{Path: tree, Mode: proto.Uint32(0o444), Recursive: true})); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(keep); err != nil || st.Mode().Perm() != 0o666 {
		t.Fatalf("recursive chmod followed a junction: %v, %v", st.Mode(), err)
	}

	rres, err := h.fs.Remove(ctx, connect.NewRequest(&agentv1.FilesystemRemoveRequest{Path: tree, Recursive: true}))
	if err != nil {
		t.Fatal(err)
	}
	if !rres.Msg.GetExisted() {
		t.Fatal("existed = false")
	}
	if _, err := os.Lstat(tree); !os.IsNotExist(err) {
		t.Fatalf("tree still exists: %v", err)
	}
	if b, err := os.ReadFile(keep); err != nil || string(b) != "keep" {
		t.Fatalf("junction target lost %s: %q, %v", keep, b, err)
	}
}

// accountName is the localized account name of a well-known SID.
func accountName(t *testing.T, typ windows.WELL_KNOWN_SID_TYPE) string {
	t.Helper()
	sid, err := windows.CreateWellKnownSid(typ)
	if err != nil {
		t.Fatal(err)
	}
	name, _, _, err := sid.LookupAccount("")
	if err != nil {
		t.Fatal(err)
	}
	return name
}

func TestOwnerName(t *testing.T) {
	h := newHarness(t)
	ctx := h.ctx()
	system := accountName(t, windows.WinLocalSystemSid)

	p := h.path("own", "f.txt")
	fi := fileInfo(t, wantStatus(t, h.do(http.MethodPut, "/files", q("path", p), strings.NewReader("x"), nil), http.StatusOK))
	if fi.GetOwner() != system || fi.GetGroup() != "" || fi.GetUid() != 0 || fi.GetGid() != 0 || fi.GetMode() != 0o644 {
		t.Fatalf("new file: owner %q group %q uid %d gid %d mode %o, want %s, 644", fi.GetOwner(), fi.GetGroup(), fi.GetUid(), fi.GetGid(), fi.GetMode(), system)
	}
	exe := h.path("own", "tool.exe")
	if fi := fileInfo(t, wantStatus(t, h.do(http.MethodPut, "/files", q("path", exe), strings.NewReader("x"), nil), http.StatusOK)); fi.GetMode() != 0o755 {
		t.Fatalf("exe mode %o, want 755", fi.GetMode())
	}
	mres, err := h.fs.MakeDir(ctx, connect.NewRequest(&agentv1.MakeDirRequest{Path: h.path("own", "d")}))
	if err != nil {
		t.Fatal(err)
	}
	if fi := mres.Msg.GetInfo(); fi.GetMode() != 0o755 || fi.GetOwner() != system {
		t.Fatalf("dir: mode %o owner %q", fi.GetMode(), fi.GetOwner())
	}

	// Another owner shows its (localized) account name.
	enableFSPrivileges()
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, admins, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	stat := func() *agentv1.FileInfo {
		t.Helper()
		res, err := h.fs.Stat(ctx, connect.NewRequest(&agentv1.StatRequest{Path: p}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg.GetInfo()
	}
	if got, want := stat().GetOwner(), accountName(t, windows.WinBuiltinAdministratorsSid); got != want {
		t.Fatalf("owner %q, want %q", got, want)
	}

	// Chmod: only the owner write bit counts; the group is ignored.
	cres, err := h.fs.Chmod(ctx, connect.NewRequest(&agentv1.ChmodRequest{Path: p, Mode: proto.Uint32(0o400), Owner: "SYSTEM:nosuchgroup", Group: "nosuchgroup"}))
	if err != nil {
		t.Fatal(err)
	}
	if fi := cres.Msg.GetInfo(); fi.GetMode() != 0o444 || fi.GetOwner() != system {
		t.Fatalf("after chmod: mode %o owner %q", fi.GetMode(), fi.GetOwner())
	}
	if st, err := os.Stat(p); err != nil || st.Mode().Perm()&0o200 != 0 {
		t.Fatalf("read-only attribute not set: %v, %v", st.Mode(), err)
	}
	if _, err := h.fs.Chmod(ctx, connect.NewRequest(&agentv1.ChmodRequest{Path: p, Mode: proto.Uint32(0o600)})); err != nil {
		t.Fatal(err)
	}
	if got := stat().GetMode(); got != 0o644 {
		t.Fatalf("mode %o after chmod 600, want 644", got)
	}

	// The default account of the template, when this machine has it.
	if _, err := process.LookupUser("user"); err != nil {
		t.Logf("no account user: %v", err)
		return
	}
	if _, err := h.fs.Chmod(ctx, connect.NewRequest(&agentv1.ChmodRequest{Path: p, Owner: "user"})); err != nil {
		t.Fatal(err)
	}
	if got := stat().GetOwner(); got != "user" {
		t.Fatalf("owner %q, want user", got)
	}
	fi = fileInfo(t, wantStatus(t, h.do(http.MethodPut, "/files", q("path", p, "user", "user"), strings.NewReader("y"), nil), http.StatusOK))
	if fi.GetOwner() != "user" {
		t.Fatalf("file written for user is owned by %q", fi.GetOwner())
	}
}
