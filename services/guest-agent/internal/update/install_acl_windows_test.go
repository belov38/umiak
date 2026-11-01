package update

import (
	"crypto/ed25519"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/belov38/umiak/services/guest-agent/internal/fsutil"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

func TestInstallInheritsVersionsACL(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	if err := fsutil.MkdirSecure(l.StagingDir, fsutil.SystemOnly); err != nil {
		t.Fatal(err)
	}
	if err := fsutil.MkdirSecure(l.VersionsDir, fsutil.SystemAndAdmins); err != nil {
		t.Fatal(err)
	}
	pub, priv := testKey(t)
	if _, err := Install(l, packTest(t, "v-acl", priv), []ed25519.PublicKey{pub}, InstallOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{VersionDir(l, "v-acl"), filepath.Join(VersionDir(l, "v-acl"), BinaryName)} {
		sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(sd.String(), ";;;BA)") {
			t.Errorf("version lost inherited admin access: %s: %s", p, sd.String())
		}
		t.Logf("%s ACL: %s", p, sd.String())
	}
}
