package files

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
)

func TestUploadInheritsTargetACL(t *testing.T) {
	root := t.TempDir()
	state, dest := filepath.Join(root, "state"), filepath.Join(root, "dest")
	if err := fsutil.MkdirSecure(state, fsutil.SystemOnly); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.MkdirSecure(dest, fsutil.SystemAndAdmins); err != nil {
		t.Fatal(err)
	}
	src, target := filepath.Join(state, "upload"), filepath.Join(dest, "file.txt")
	if err := os.WriteFile(src, []byte("upload"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := finishUpload(src, target, 0644, owner{}, true); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sd.String(), ";;;BA)") {
		t.Fatalf("target lost inherited admin access: %s", sd.String())
	}
	t.Logf("target ACL: %s", sd.String())
}
