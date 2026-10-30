package claim

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
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
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := secureSecretFile(path, fs.FileMode(tc.mode), users); err != nil {
			t.Fatalf("%o: %v", tc.mode, err)
		}
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
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := secureSecretFile(path, 0o440, nil); err != nil {
		t.Fatal(err)
	}
	if got := aces(t, path); len(got) != 1 || got[system.String()] != fileAllAccess {
		t.Errorf("ACEs without a user = %v, want SYSTEM only", got)
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
