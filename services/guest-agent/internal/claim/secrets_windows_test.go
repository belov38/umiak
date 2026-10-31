package claim

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"connectrpc.com/connect"
	"golang.org/x/sys/windows"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
)

// fileAllAccess is the SDDL right FA.
const fileAllAccess windows.ACCESS_MASK = 0x1f01ff

// openShared opens path for reading with the given share mode, as a user
// program holding a secret file would.
func openShared(t *testing.T, path string, share uint32) *os.File {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, share, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	f := os.NewFile(uintptr(h), path)
	t.Cleanup(func() { _ = f.Close() })
	return f
}

func TestWipeFileZeroesAndDeletes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	content := bytes.Repeat([]byte("s3cret!"), 20000) // more than one wipe chunk
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	// A reader that shares everything sees the zeroed data through its
	// handle; the name is gone once the handles are closed.
	f := openShared(t, path, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE)
	if err := wipeFile(path); err != nil {
		t.Fatalf("wipeFile: %v", err)
	}
	got, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(content) || !bytes.Equal(got, make([]byte, len(content))) {
		t.Errorf("content after wipe: %d bytes, zeroed=%v", len(got), bytes.Equal(got, make([]byte, len(got))))
	}
	// While the reader keeps the name, the file is delete-pending: a second
	// wipe counts it as wiped, a new secret by that name is in use.
	if !isDeletePending(path) {
		t.Error("wiped file held open is not delete-pending")
	}
	if err := wipeFile(path); err != nil {
		t.Errorf("wipeFile of a delete-pending file = %v, want nil", err)
	}
	if err := writeSecret(path, []byte("new"), 0o440, nil); !errors.Is(err, ErrSecretInUse) {
		t.Errorf("writeSecret over a delete-pending file = %v, want ErrSecretInUse", err)
	}
	if err := internal("write secret", fmt.Errorf("x: %w", ErrSecretInUse)); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("in-use write maps to %v, want failed_precondition", err)
	}
	_ = f.Close()
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("file present after wipe (%v)", err)
	}

	// A read-only file is wiped too.
	if err := os.WriteFile(path, content, 0o400); err != nil {
		t.Fatal(err)
	}
	if err := wipeFile(path); err != nil {
		t.Fatalf("wipeFile of a read-only file: %v", err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("read-only file present after wipe (%v)", err)
	}
}

func TestWipeOpenFileIsInUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(path, []byte("held open"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, share := range []uint32{
		windows.FILE_SHARE_READ,
		windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE,
	} {
		f := openShared(t, path, share)
		if err := wipeFile(path); !errors.Is(err, ErrSecretInUse) {
			t.Errorf("share %#x: wipeFile = %v, want ErrSecretInUse", share, err)
		}
		_ = f.Close()
		if b, err := os.ReadFile(path); err != nil || string(b) != "held open" {
			t.Errorf("share %#x: content after a refused wipe = %q (%v)", share, b, err)
		}
	}
	if err := wipeFile(path); err != nil {
		t.Fatalf("wipeFile after close: %v", err)
	}
}

// isSystem reports whether the test runs as LocalSystem.
func isSystem(t *testing.T) bool {
	t.Helper()
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return tu.User.Sid.IsWellKnown(windows.WinLocalSystemSid)
}

func TestWriteSecretReplacesInPlace(t *testing.T) {
	if !isSystem(t) {
		t.Skip("replacing a SYSTEM-only secret file needs SYSTEM")
	}
	path := filepath.Join(t.TempDir(), "secret")
	old := bytes.Repeat([]byte("old-secret"), 1000)
	if err := writeSecret(path, old, 0o440, nil); err != nil {
		t.Fatal(err)
	}
	// A reader sharing everything keeps the old file: it sees zeros after
	// the replace, the name has the new content.
	f := openShared(t, path, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE)
	if err := writeSecret(path, []byte("new"), 0o440, nil); err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, make([]byte, len(old))) {
		t.Error("old secret content not zeroed by the replace")
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "new" {
		t.Errorf("content = %q (%v), want new", b, err)
	}
	if _, err := os.Lstat(path + tmpSuffix); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("temporary file left (%v)", err)
	}

	// A reader without write sharing blocks the replace and keeps the file.
	_ = f.Close()
	g := openShared(t, path, windows.FILE_SHARE_READ)
	if err := writeSecret(path, []byte("newer"), 0o440, nil); !errors.Is(err, ErrSecretInUse) {
		t.Errorf("writeSecret over a held file = %v, want ErrSecretInUse", err)
	}
	_ = g.Close()
	if b, err := os.ReadFile(path); err != nil || string(b) != "new" {
		t.Errorf("content after a refused replace = %q (%v)", b, err)
	}
}

// aces returns the allowed ACEs of path's DACL by SID string.
func aces(t *testing.T, path string) map[string]windows.ACCESS_MASK {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]windows.ACCESS_MASK{}
	for i := range uint32(dacl.AceCount) {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			t.Fatalf("ACE %d has type %d", i, ace.Header.AceType)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		out[sid.String()] |= ace.Mask
	}
	return out
}

func TestSecretFileACL(t *testing.T) {
	// Users stands in for the default account; the file stays reachable for
	// the test through its owner rights and the parent directory.
	users, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatal(err)
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	const write = windows.FILE_WRITE_DATA | windows.FILE_APPEND_DATA
	for _, tc := range []struct {
		mode      uint32
		userWrite bool
	}{
		{0o400, false},
		{0o440, false},
		{0o640, true},
		{0o602, true},
	} {
		path := filepath.Join(t.TempDir(), "secret")
		if err := writeSecret(path, []byte("x"), fs.FileMode(tc.mode), users); err != nil {
			t.Fatalf("%o: %v", tc.mode, err)
		}
		wantProtected(t, path)
		got := aces(t, path)
		if len(got) != 2 {
			t.Errorf("%o: ACEs = %v, want SYSTEM and the user only", tc.mode, got)
		}
		if got[system.String()] != fileAllAccess {
			t.Errorf("%o: SYSTEM mask = %#x, want full", tc.mode, got[system.String()])
		}
		um := got[users.String()]
		if um&windows.FILE_READ_DATA == 0 {
			t.Errorf("%o: user mask %#x cannot read", tc.mode, um)
		}
		if (um&write != 0) != tc.userWrite {
			t.Errorf("%o: user mask %#x, write = %v, want %v", tc.mode, um, um&write != 0, tc.userWrite)
		}
		attrs := fileAttrs(t, path)
		if attrs&windows.FILE_ATTRIBUTE_TEMPORARY == 0 || attrs&windows.FILE_ATTRIBUTE_READONLY != 0 {
			t.Errorf("%o: attributes = %#x, want TEMPORARY and not READONLY", tc.mode, attrs)
		}
	}

	// Without a known user the file is SYSTEM only.
	path := filepath.Join(t.TempDir(), "secret")
	if err := writeSecret(path, []byte("x"), 0o440, nil); err != nil {
		t.Fatal(err)
	}
	if got := aces(t, path); len(got) != 1 || got[system.String()] != fileAllAccess {
		t.Errorf("ACEs without a user = %v, want SYSTEM only", got)
	}
}

func TestSecretDirACL(t *testing.T) {
	users, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatal(err)
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	mount := filepath.Join(t.TempDir(), "sbx")
	if err := mountSecrets(mount); err != nil {
		t.Fatal(err)
	}
	wantProtected(t, mount)
	if got := aces(t, mount); len(got) != 2 || got[system.String()] != fileAllAccess || got[admins.String()] != fileAllAccess {
		t.Errorf("mount ACEs = %v, want SYSTEM and Administrators full", got)
	}

	dir := filepath.Join(mount, "secrets")
	if err := os.Mkdir(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := setDACL(dir, secretDirACL(users)); err != nil {
		t.Fatal(err)
	}
	wantProtected(t, dir)
	got := aces(t, dir)
	if len(got) != 2 || got[system.String()] != fileAllAccess {
		t.Errorf("secrets dir ACEs = %v, want SYSTEM full and the user", got)
	}
	if um := got[users.String()]; um&windows.FILE_LIST_DIRECTORY == 0 || um&windows.FILE_WRITE_DATA != 0 {
		t.Errorf("user mask on the secrets dir = %#x, want list without write", um)
	}
}

// wantProtected asserts that the DACL of path is protected and has no
// inherited ACE.
func wantProtected(t *testing.T, path string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	ctl, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if ctl&windows.SE_DACL_PROTECTED == 0 {
		t.Errorf("%s: DACL not protected", path)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for i := range uint32(dacl.AceCount) {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceFlags&windows.INHERITED_ACE != 0 {
			t.Errorf("%s: ACE %d is inherited", path, i)
		}
	}
}

func fileAttrs(t *testing.T, path string) uint32 {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	a, err := windows.GetFileAttributes(p)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestClaimDoesNotApplyHostnameOnWindows(t *testing.T) {
	h := newHarness(t)
	resp, err := h.m.Claim(t.Context(), fullRequest())
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetHostnameApplied() {
		t.Error("hostname_applied = true on Windows")
	}
	if got := h.hostnameCalls(); len(got) != 0 {
		t.Errorf("hostname set on Windows: %v", got)
	}
}

// TestRestoreOverHeldFileSetsPending: a secret file held open through the
// wipe, whose content changed by a deferred UpdateSecrets, cannot be
// written back: the other files are restored and the secrets phase becomes
// pending.
func TestRestoreOverHeldFileSetsPending(t *testing.T) {
	if !isSystem(t) {
		t.Skip("opening a SYSTEM-only secret file needs SYSTEM")
	}
	h := newHarness(t)
	ctx := t.Context()
	if _, err := h.m.Claim(ctx, twoFiles()); err != nil {
		t.Fatal(err)
	}
	f := openShared(t, filepath.Join(h.l.SecretFilesDir, "key.pem"), windows.FILE_SHARE_READ)
	defer func() { _ = f.Close() }() //nolint:errcheck // test cleanup
	if _, err := h.m.WipeSecretFiles(); !errors.Is(err, ErrSecretInUse) {
		t.Fatalf("WipeSecretFiles = %v, want ErrSecretInUse", err)
	}
	files := twoFiles().GetSecretFiles()
	for _, f := range files {
		if f.GetName() == "key.pem" {
			f.Content = []byte("rotated")
		}
	}
	if _, err := h.m.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{SecretFiles: files}); err != nil {
		t.Fatal(err)
	}
	if err := h.m.RestoreSecretFiles(); err == nil {
		t.Fatal("RestoreSecretFiles succeeded over a held file")
	}
	if b, err := os.ReadFile(filepath.Join(h.l.SecretFilesDir, "token")); err != nil || string(b) != "tok-"+secretFileValue {
		t.Errorf("token = %q (%v), want restored", b, err)
	}
	if st, _ := h.tr.State(readiness.PhaseSecrets); st != pending {
		t.Errorf("secrets phase = %v, want pending", st)
	}
}

func TestReplaceFailureRemovesZeroedSecret(t *testing.T) {
	dir := t.TempDir()
	dst, tmp := filepath.Join(dir, "secret"), filepath.Join(dir, "temp")
	if err := os.WriteFile(dst, []byte("old secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tmp, []byte("new secret"), 0600); err != nil {
		t.Fatal(err)
	}
	f := openShared(t, tmp, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE)
	defer func() { _ = f.Close() }()
	if err := replaceSecret(tmp, dst); err == nil {
		t.Fatal("replacement failure was hidden")
	}
	if _, err := os.Stat(dst); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("zeroed secret remains: %v", err)
	}
}
