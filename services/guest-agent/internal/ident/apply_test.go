package ident

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mustNotExist(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("%s: want not exist, got %v", path, err)
	}
}

// newFake returns a resetter that writes one host key like ssh-keygen -A.
func newFake(t *testing.T, l paths.Layout) (*FakeResetter, *string) {
	t.Helper()
	var fp string
	f := &FakeResetter{OnRegenerate: func() error {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		sp, err := ssh.NewPublicKey(pub)
		if err != nil {
			return err
		}
		fp = ssh.FingerprintSHA256(sp)
		line := ssh.MarshalAuthorizedKey(sp)
		if err := os.MkdirAll(l.SSHDir, 0o755); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(l.SSHDir, "ssh_host_ed25519_key.pub"), line, 0o644)
	}}
	return f, &fp
}

// linuxApply skips a test of the Linux identity apply (Apply, Seal) on
// Windows: the Windows layout has none of its files (machine-id, hosts,
// /etc/sbx/env), and Windows runs ApplyWindows and SealWindows instead
// (apply_win_core_test.go, seal_win_core_test.go).
func linuxApply(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the Linux identity apply; Windows runs ApplyWindows and SealWindows")
	}
}

func testIdentity(machineID string) Identity {
	return Identity{MachineID: machineID, BS: testBS()}
}

func TestApplySameMachineNoop(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.StateDB, "db")
	mustWrite(t, l.SbxEnvFile, "A=1\n")
	f := &File{MachineID: testMachineID, WrittenMachineID: testHex}
	if err := f.Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	r := &FakeResetter{}
	changed, err := Apply(context.Background(), l, testIdentity(strings.ToUpper(testMachineID)), r, false)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("changed = true for the same machine")
	}
	if len(r.Calls) != 0 {
		t.Errorf("resetter calls = %v", r.Calls)
	}
	if mustRead(t, l.StateDB) != "db" || mustRead(t, l.SbxEnvFile) != "A=1\n" {
		t.Error("files were touched")
	}
	got, err := LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if got.ResetPending {
		t.Error("ResetPending was set by a no-op")
	}
}

func TestApplyChangedResetsState(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	old := "aaaaaaaabbbbccccddddeeeeeeeeeeee"
	if err := (&File{MachineID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", WrittenMachineID: old}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, l.StateDB, "db")
	mustWrite(t, filepath.Join(l.CommandsDir, "c1", "stdout"), "out")
	mustWrite(t, filepath.Join(l.UploadsDir, "u1"), "up")
	mustWrite(t, l.PendingUpdateFile, "{}")
	managed, err := l.Rooted("/etc/managed.conf")
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, managed, "x")
	mustWrite(t, l.ManagedFilesList, "# comment\n\nrelative/path\n/etc/managed.conf\n/etc/absent\n")
	mustWrite(t, l.SbxEnvFile, "SECRET_ISH=1\n")
	mustWrite(t, l.SSHUserCA, "ssh-ed25519 OLD\n")
	mustWrite(t, l.TemplateSSHCA, "ssh-ed25519 TEMPLATE\n")
	mustWrite(t, l.MachineIDFile, old+"\n")
	mustWrite(t, l.HostnameFile, "oldname\n")
	mustWrite(t, l.HostsFile, "127.0.0.1 localhost\n")

	r, fp := newFake(t, l)
	changed, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("changed = false")
	}

	mustNotExist(t, l.StateDB)
	mustNotExist(t, l.CommandsDir)
	mustNotExist(t, l.UploadsDir)
	mustNotExist(t, l.PendingUpdateFile)
	mustNotExist(t, managed)
	if got := mustRead(t, l.SbxEnvFile); got != "" {
		t.Errorf("env = %q, want empty", got)
	}
	if got := mustRead(t, l.SSHUserCA); got != "ssh-ed25519 TEMPLATE\n" {
		t.Errorf("ssh ca = %q", got)
	}
	if got := mustRead(t, l.MachineIDFile); got != testHex+"\n" {
		t.Errorf("machine-id = %q", got)
	}
	if got := mustRead(t, l.HostnameFile); got != testHostname+"\n" {
		t.Errorf("hostname file = %q", got)
	}
	hosts := mustRead(t, l.HostsFile)
	if !strings.Contains(hosts, "127.0.0.1 localhost\n") ||
		!strings.Contains(hosts, "# BEGIN sbx\n127.0.1.1 "+testHostname+"\n# END sbx\n") {
		t.Errorf("hosts = %q", hosts)
	}

	wantCalls := []string{"RegenerateHostKeys", "SetHostname " + testHostname, "RestartJournal"}
	if !reflect.DeepEqual(r.Calls, wantCalls) {
		t.Errorf("calls = %v, want %v", r.Calls, wantCalls)
	}

	f, err := LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	want := &File{
		MachineID: testMachineID, WrittenMachineID: testHex,
		HostKeyFingerprints: []string{*fp}, ResetPending: true,
	}
	if !reflect.DeepEqual(f, want) {
		t.Errorf("identity.json = %+v, want %+v", f, want)
	}
}

func TestApplyFirstBootAfterSeal(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.MachineIDFile, "")
	mustWrite(t, l.TemplateSSHCA, "")
	r, _ := newFake(t, l)
	changed, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false)
	if err != nil || !changed {
		t.Fatalf("changed = %v, err = %v", changed, err)
	}
	if got := mustRead(t, l.MachineIDFile); got != testHex+"\n" {
		t.Errorf("machine-id = %q", got)
	}
	if m, _ := filepath.Glob(filepath.Join(filepath.Dir(l.SbxEnvFile), ".*.tmp-*")); len(m) != 0 {
		t.Errorf("temporary files left behind: %v", m)
	}
	if got := mustRead(t, l.SSHUserCA); got != "" {
		t.Errorf("ssh ca = %q, want empty", got)
	}
	if got := mustRead(t, l.HostsFile); got != "# BEGIN sbx\n127.0.1.1 "+testHostname+"\n# END sbx\n" {
		t.Errorf("hosts = %q", got)
	}
}

func TestApplyHostsBlockReplacedNotDuplicated(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.HostsFile, "127.0.0.1 localhost\n::1 localhost\n")
	r, _ := newFake(t, l)
	other := "0190a1b2-c3d4-7e5f-8a9b-ffffffffffff"
	for _, id := range []string{testMachineID, other} {
		if _, err := Apply(context.Background(), l, testIdentity(id), r, false); err != nil {
			t.Fatal(err)
		}
	}
	hosts := mustRead(t, l.HostsFile)
	if n := strings.Count(hosts, "# BEGIN sbx"); n != 1 {
		t.Errorf("BEGIN count = %d in %q", n, hosts)
	}
	if strings.Contains(hosts, testHostname) {
		t.Errorf("old hostname left in %q", hosts)
	}
	want := "127.0.0.1 localhost\n::1 localhost\n# BEGIN sbx\n127.0.1.1 sbx-ffffffffffff\n# END sbx\n"
	if hosts != want {
		t.Errorf("hosts = %q, want %q", hosts, want)
	}
}

func TestHostsBlockKeepsSurroundingLines(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.HostsFile, "a\n# BEGIN sbx\n127.0.1.1 old\n# END sbx\nb\n")
	if err := SetHostsBlock(l.HostsFile, "new"); err != nil {
		t.Fatal(err)
	}
	want := "a\n# BEGIN sbx\n127.0.1.1 new\n# END sbx\nb\n"
	if got := mustRead(t, l.HostsFile); got != want {
		t.Errorf("hosts = %q, want %q", got, want)
	}
}

func TestMachineIDRules(t *testing.T) {
	linuxApply(t)
	old := "aaaaaaaabbbbccccddddeeeeeeeeeeee"
	for _, tt := range []struct {
		name    string
		current *string // nil: file absent
		want    string
	}{
		{"absent", nil, testHex},
		{"empty", ptr(""), testHex},
		{"blank line", ptr("\n"), testHex},
		{"uninitialized", ptr("uninitialized\n"), testHex},
		{"inherited from old identity", ptr(old + "\n"), testHex},
		{"set by systemd", ptr("1234567890abcdef1234567890abcdef\n"), "1234567890abcdef1234567890abcdef"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			l := paths.ForRoot(t.TempDir())
			if err := (&File{MachineID: "old", WrittenMachineID: old}).Save(l.IdentityFile); err != nil {
				t.Fatal(err)
			}
			if tt.current != nil {
				mustWrite(t, l.MachineIDFile, *tt.current)
			}
			r, _ := newFake(t, l)
			if _, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false); err != nil {
				t.Fatal(err)
			}
			if got := strings.TrimSpace(mustRead(t, l.MachineIDFile)); got != tt.want {
				t.Errorf("machine-id = %q, want %q", got, tt.want)
			}
			f, err := LoadFile(l.IdentityFile)
			if err != nil {
				t.Fatal(err)
			}
			if f.WrittenMachineID != tt.want {
				t.Errorf("WrittenMachineID = %q, want %q", f.WrittenMachineID, tt.want)
			}
		})
	}
}

func ptr(s string) *string { return &s }

func TestApplyDbusSymlink(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.DbusMachineID, "stale\n") // regular file from the image
	r, _ := newFake(t, l)
	if _, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false); err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(l.DbusMachineID)
	if err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if target != l.MachineIDFile {
		t.Errorf("symlink target = %q, want %q", target, l.MachineIDFile)
	}
	if got := mustRead(t, l.DbusMachineID); got != testHex+"\n" {
		t.Errorf("dbus machine-id = %q", got)
	}
}

func TestApplyFromAgentRestartsServices(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	r, _ := newFake(t, l)
	r.Errs = map[string]error{"ReloadNetwork": errors.New("networkctl missing")}
	changed, err := Apply(context.Background(), l, testIdentity(testMachineID), r, true)
	if err != nil || !changed {
		t.Fatalf("changed = %v, err = %v (service errors must not fail the apply)", changed, err)
	}
	want := []string{"RegenerateHostKeys", "SetHostname " + testHostname, "RestartSSH", "ReloadNetwork"}
	if !reflect.DeepEqual(r.Calls, want) {
		t.Errorf("calls = %v, want %v", r.Calls, want)
	}
}

// savedCheck is a FakeResetter that records whether identity.json was
// already written when sshd is restarted.
type savedCheck struct {
	*FakeResetter
	path  string
	saved bool
}

func (s *savedCheck) RestartSSH() error {
	_, err := os.Stat(s.path)
	s.saved = err == nil
	return s.FakeResetter.RestartSSH()
}

// The agent fallback saves identity.json before it restarts sshd and the
// network: a hang there must not repeat the wipe on the next start.
func TestApplyFromAgentSavesBeforeServices(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	r, _ := newFake(t, l)
	sc := &savedCheck{FakeResetter: r, path: l.IdentityFile}
	if _, err := Apply(context.Background(), l, testIdentity(testMachineID), sc, true); err != nil {
		t.Fatal(err)
	}
	if !sc.saved {
		t.Error("identity.json was written after RestartSSH")
	}
}

func TestApplyFailureLeavesNoIdentityFile(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	r, _ := newFake(t, l)
	r.Errs = map[string]error{"SetHostname": errors.New("boom")}
	if _, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false); err == nil {
		t.Fatal("want error")
	}
	mustNotExist(t, l.IdentityFile)
}

func TestApplyCorruptIdentityFileIsReset(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.IdentityFile, "{not json")
	r, _ := newFake(t, l)
	changed, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false)
	if err != nil || !changed {
		t.Fatalf("changed = %v, err = %v", changed, err)
	}
}

func TestApplyCanceled(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &FakeResetter{}
	if _, err := Apply(ctx, l, testIdentity(testMachineID), r, false); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v", err)
	}
}

func TestFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "identity.json")
	in := &File{MachineID: "m", WrittenMachineID: "w", HostKeyFingerprints: []string{"SHA256:a"}, ResetPending: true}
	if err := in.Save(path); err != nil {
		t.Fatal(err)
	}
	out, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Errorf("got %+v, want %+v", out, in)
	}
	if _, err := LoadFile(filepath.Join(t.TempDir(), "none")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing file: err = %v", err)
	}
}

func TestSealWipes(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.StateDB, "db")
	mustWrite(t, filepath.Join(l.CommandsDir, "c1", "stdout"), "out")
	mustWrite(t, l.IdentityFile, "{}")
	managed, err := l.Rooted("/etc/managed.conf")
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, managed, "x")
	mustWrite(t, l.ManagedFilesList, "/etc/managed.conf\n")
	mustWrite(t, l.SbxEnvFile, "A=1\n")
	mustWrite(t, l.SSHUserCA, "ssh-ed25519 OLD\n")
	mustWrite(t, l.TemplateSSHCA, "ssh-ed25519 TEMPLATE\n")
	mustWrite(t, l.MachineIDFile, testHex+"\n")
	mustWrite(t, filepath.Join(l.SSHDir, "ssh_host_ed25519_key"), "priv")
	mustWrite(t, filepath.Join(l.SSHDir, "ssh_host_ed25519_key.pub"), "pub")
	mustWrite(t, filepath.Join(l.SSHDir, "sshd_config"), "keep")
	versions := filepath.Join(l.VersionsDir, "1.0", "sbx-agent")
	mustWrite(t, versions, "bin")

	stopped := false
	if err := Seal(context.Background(), l, func() error { stopped = true; return nil }); err != nil {
		t.Fatal(err)
	}
	if !stopped {
		t.Error("stopAgent was not called")
	}
	mustNotExist(t, l.StateDir)
	mustNotExist(t, managed)
	mustNotExist(t, filepath.Join(l.SSHDir, "ssh_host_ed25519_key"))
	mustNotExist(t, filepath.Join(l.SSHDir, "ssh_host_ed25519_key.pub"))
	if got := mustRead(t, filepath.Join(l.SSHDir, "sshd_config")); got != "keep" {
		t.Errorf("sshd_config = %q", got)
	}
	if fi, err := os.Stat(l.MachineIDFile); err != nil || fi.Size() != 0 {
		t.Errorf("machine-id: err = %v, want an empty file", err)
	}
	if got := mustRead(t, l.SbxEnvFile); got != "" {
		t.Errorf("env = %q", got)
	}
	if got := mustRead(t, l.SSHUserCA); got != "ssh-ed25519 TEMPLATE\n" {
		t.Errorf("ssh ca = %q", got)
	}
	if got := mustRead(t, versions); got != "bin" {
		t.Errorf("version dir was touched: %q", got)
	}
}

func TestSealStopFailureAborts(t *testing.T) {
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.StateDB, "db")
	err := Seal(context.Background(), l, func() error { return errors.New("cannot stop") })
	if err == nil {
		t.Fatal("want error")
	}
	if mustRead(t, l.StateDB) != "db" {
		t.Error("state was wiped although the agent could not be stopped")
	}
}

func TestSealThenApplyIsFirstBoot(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	mustWrite(t, l.TemplateSSHCA, "ca\n")
	if err := Seal(context.Background(), l, nil); err != nil {
		t.Fatal(err)
	}
	r, _ := newFake(t, l)
	changed, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false)
	if err != nil || !changed {
		t.Fatalf("changed = %v, err = %v", changed, err)
	}
	if got := mustRead(t, l.MachineIDFile); got != testHex+"\n" {
		t.Errorf("machine-id = %q", got)
	}
}

func TestManagedFilesConfinedToLayout(t *testing.T) {
	root := t.TempDir()
	l := paths.ForRoot(root)
	// The list holds production paths: /x on Linux, C:\x on Windows.
	abs := func(p string) string { return p }
	if runtime.GOOS == "windows" {
		abs = func(p string) string { return `C:` + filepath.FromSlash(p) }
	}
	// Files that the list must never reach: outside the layout root.
	outside := filepath.Join(t.TempDir(), "outside")
	mustWrite(t, outside, "keep")
	inside, err := l.Rooted(abs("/etc/inside.conf"))
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, inside, "x")
	sentinel := filepath.Join(root, "etc", "sentinel")
	mustWrite(t, sentinel, "keep")
	rel, err := filepath.Rel(root, outside)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, l.ManagedFilesList, strings.Join([]string{
		abs("/"),
		"../x",
		abs("/../x"),
		abs("/etc/../../") + rel,
		outside, // an absolute host path is re-rooted under the layout, so the real file is untouched
		abs("/etc/inside.conf"),
		"",
	}, "\n"))

	got := managedFiles(l)
	if len(got) != 2 || got[1] != inside {
		// outside is re-rooted to <root><outside>, inside is the second entry.
		t.Fatalf("managedFiles = %v", got)
	}
	for _, p := range got {
		if !strings.HasPrefix(p, root+string(filepath.Separator)) {
			t.Errorf("%q escapes the layout root", p)
		}
	}

	if runtime.GOOS == "windows" {
		r := newWinFake(t, l, WindowsComputerName(testMachineID))
		if _, _, err := ApplyWindows(context.Background(), l, testIdentity(testMachineID), r, ModeEarly); err != nil {
			t.Fatal(err)
		}
	} else {
		r, _ := newFake(t, l)
		if _, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false); err != nil {
			t.Fatal(err)
		}
	}
	mustNotExist(t, inside)
	if mustRead(t, outside) != "keep" || mustRead(t, sentinel) != "keep" {
		t.Error("a file outside the managed list was removed")
	}
	if _, err := os.Stat(root); err != nil {
		t.Errorf("layout root removed: %v", err)
	}
}

func TestApplyFailureKeepsOldIdentityFileAndRetryRewipes(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	oldFile := &File{MachineID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", WrittenMachineID: "aaaaaaaabbbbccccddddeeeeeeeeeeee"}
	if err := oldFile.Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, l.StateDB, "db")
	r, _ := newFake(t, l)
	r.Errs = map[string]error{"SetHostname": errors.New("boom")}
	if _, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false); err == nil {
		t.Fatal("want error")
	}
	got, err := LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, oldFile) {
		t.Errorf("identity.json = %+v, want the old %+v", got, oldFile)
	}

	// Retry: state reappears (as if the agent ran in between) and is wiped again.
	mustWrite(t, l.StateDB, "db2")
	r.Errs = nil
	changed, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false)
	if err != nil || !changed {
		t.Fatalf("retry: changed = %v, err = %v", changed, err)
	}
	mustNotExist(t, l.StateDB)
	got, err = LoadFile(l.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	if got.MachineID != testMachineID || !got.ResetPending {
		t.Errorf("identity.json after retry = %+v", got)
	}
}

func TestHostKeyFingerprintsWarnsWhenNoneParse(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "ssh_host_rsa_key.pub"), "garbage\n")
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })

	fps, err := hostKeyFingerprints(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(fps) != 0 {
		t.Errorf("fps = %v", fps)
	}
	if !strings.Contains(buf.String(), "no usable ssh host keys") {
		t.Errorf("log = %q, want a no-usable-keys warning", buf.String())
	}
}

// identity.json is created in a root 0700 state directory (spec 4).
func TestSaveCreatesStateDir0700(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("state\\ gets its protected DACL from SecureAgentDirs (TestEarlySecuresAgentDirs), not from Save")
	}
	l := paths.ForRoot(t.TempDir())
	if err := (&File{MachineID: testMachineID}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Dir(l.IdentityFile))
	if err != nil {
		t.Fatal(err)
	}
	if m := fi.Mode().Perm(); m != 0o700 {
		t.Errorf("state dir mode = %o, want 700", m)
	}
}

// A fork inherits the parent's machine-id, which journald picked up at its
// start: replacing it restarts journald. A machine-id that systemd chose, or
// none at all, is no reason to.
func TestApplyRestartsJournalOnlyWhenReplacingAnID(t *testing.T) {
	linuxApply(t)
	old := "aaaaaaaabbbbccccddddeeeeeeeeeeee"
	for _, tt := range []struct {
		name    string
		current *string
		restart bool
	}{
		{"inherited from old identity", ptr(old + "\n"), true},
		{"set by systemd", ptr("1234567890abcdef1234567890abcdef\n"), false},
		{"empty", ptr(""), false},
		{"uninitialized", ptr("uninitialized\n"), false},
		{"absent", nil, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			l := paths.ForRoot(t.TempDir())
			if err := (&File{MachineID: "old", WrittenMachineID: old}).Save(l.IdentityFile); err != nil {
				t.Fatal(err)
			}
			if tt.current != nil {
				mustWrite(t, l.MachineIDFile, *tt.current)
			}
			r, _ := newFake(t, l)
			r.Errs = map[string]error{"RestartJournal": errors.New("no systemd")}
			if _, err := Apply(context.Background(), l, testIdentity(testMachineID), r, false); err != nil {
				t.Fatalf("apply: %v (a journald failure must not fail it)", err)
			}
			if got := slices.Contains(r.Calls, "RestartJournal"); got != tt.restart {
				t.Errorf("RestartJournal called = %v, want %v (calls %v)", got, tt.restart, r.Calls)
			}
		})
	}
}

// journald restarts after identity.json is saved, so a hang there does not
// repeat the wipe.
func TestApplyRestartsJournalAfterSave(t *testing.T) {
	linuxApply(t)
	l := paths.ForRoot(t.TempDir())
	old := "aaaaaaaabbbbccccddddeeeeeeeeeeee"
	if err := (&File{MachineID: "old", WrittenMachineID: old}).Save(l.IdentityFile); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, l.MachineIDFile, old+"\n")
	r, _ := newFake(t, l)
	jc := &journalCheck{FakeResetter: r, path: l.IdentityFile}
	if _, err := Apply(context.Background(), l, testIdentity(testMachineID), jc, false); err != nil {
		t.Fatal(err)
	}
	if !jc.saved {
		t.Error("journald was restarted before identity.json had the new machine")
	}
}

type journalCheck struct {
	*FakeResetter
	path  string
	saved bool
}

func (j *journalCheck) RestartJournal() error {
	f, err := LoadFile(j.path)
	j.saved = err == nil && f.MachineID == testMachineID
	return j.FakeResetter.RestartJournal()
}
