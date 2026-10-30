package update

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// TestJunctionSwitch switches the current junction v1 -> v2: LinkVersion
// follows, files resolve through it, v1 stays intact and no temporary
// junction is left.
func TestJunctionSwitch(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	for _, v := range []string{"v1", "v2"} {
		writeFile(t, VersionDir(l, v), BinaryName, "agent "+v)
	}
	for _, v := range []string{"v1", "v2"} {
		if err := pointLink(l, l.CurrentLink, v); err != nil {
			t.Fatalf("point current at %s: %v", v, err)
		}
		got, err := LinkVersion(l.CurrentLink)
		if err != nil || got != v {
			t.Fatalf("LinkVersion = %q, %v; want %s", got, err, v)
		}
		b, err := os.ReadFile(filepath.Join(l.CurrentLink, BinaryName))
		if err != nil || string(b) != "agent "+v {
			t.Errorf("binary through current = %q, %v", b, err)
		}
	}
	fi, err := os.Lstat(l.CurrentLink)
	if err != nil {
		t.Fatal(err)
	}
	if fi.IsDir() || fi.Mode().IsRegular() {
		t.Errorf("current mode = %v, want a junction", fi.Mode())
	}
	if b, err := os.ReadFile(filepath.Join(VersionDir(l, "v1"), BinaryName)); err != nil || string(b) != "agent v1" {
		t.Errorf("v1 after the switch = %q, %v", b, err)
	}
	entries, err := os.ReadDir(filepath.Dir(l.CurrentLink))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Errorf("leftover %s", e.Name())
		}
	}
	// previous is a junction too; a real directory is never replaced.
	if err := pointLink(l, l.PreviousLink, "v1"); err != nil {
		t.Fatal(err)
	}
	if v, _ := LinkVersion(l.PreviousLink); v != "v1" {
		t.Errorf("previous = %q", v)
	}
	if err := os.RemoveAll(l.PreviousLink); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(VersionDir(l, "v1"), BinaryName)); err != nil {
		t.Errorf("removing the junction removed the target: %v", err)
	}
	if err := os.Mkdir(l.PreviousLink, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := pointLink(l, l.PreviousLink, "v2"); err == nil {
		t.Error("a real directory at previous was replaced")
	}
}

func TestMountPointReparseData(t *testing.T) {
	b, err := mountPointReparseData(`\??\C:\x`, `C:\x`)
	if err != nil {
		t.Fatal(err)
	}
	le := binary.LittleEndian
	if tag := le.Uint32(b); tag != windows.IO_REPARSE_TAG_MOUNT_POINT {
		t.Errorf("tag = %#x", tag)
	}
	// 6 + 1 and 4 + 1 UTF-16 units of path buffer.
	if n := le.Uint16(b[4:]); int(n) != 8+2*(7+5) || len(b) != 8+int(n) {
		t.Errorf("data length = %d, buffer %d", n, len(b))
	}
	if off, n, poff, pn := le.Uint16(b[8:]), le.Uint16(b[10:]), le.Uint16(b[12:]), le.Uint16(b[14:]); off != 0 || n != 12 || poff != 14 || pn != 8 {
		t.Errorf("offsets = %d %d %d %d", off, n, poff, pn)
	}
	want := []byte{'\\', 0, '?', 0, '?', 0, '\\', 0, 'C', 0, ':', 0, '\\', 0, 'x', 0, 0, 0}
	if !bytes.HasPrefix(b[16:], want[:12]) {
		t.Errorf("substitute name = %q", b[16:28])
	}
	if _, err := mountPointReparseData(`\??\`+strings.Repeat("a", 9000), "a"); err == nil {
		t.Error("an oversized target was accepted")
	}
}

func TestWithPathEntry(t *testing.T) {
	const dir = `C:\Program Files\sbx-agent\current`
	for _, tt := range []struct{ in, want string }{
		{"", dir},
		{`C:\Windows`, `C:\Windows;` + dir},
		{`C:\Windows;`, `C:\Windows;` + dir},
		{`C:\Windows;c:\program files\SBX-AGENT\current\`, `C:\Windows;c:\program files\SBX-AGENT\current\`},
	} {
		got, changed := withPathEntry(tt.in, dir)
		if got != tt.want || changed != (tt.in != tt.want) {
			t.Errorf("withPathEntry(%q) = %q, %t; want %q", tt.in, got, changed, tt.want)
		}
	}
}
