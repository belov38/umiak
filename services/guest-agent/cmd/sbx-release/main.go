// Command sbx-release builds and checks signed sbx-agent packages (spec S3
// section 17.3, decision 8).
//
//	sbx-release keygen --out <dir> [--comment c]
//	sbx-release pack --version v --os linux|windows --arch amd64 --binary <path> \
//	    --tunnel-ca <pem> --update-keys <file> --key <ed25519.key> --out <tar> \
//	    [--skip-version-check] [--allow-foreign-signer] [--allow-test-build]
//	sbx-release verify --keys <file> <tar>
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"debug/buildinfo"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

const usage = `usage: sbx-release <command>

commands:
  keygen --out <dir> [--comment c]
        write <dir>/ed25519.key (0600) and print the public key line
  pack --version v --os linux|windows --arch amd64 --binary <path>
       --tunnel-ca <pem> --update-keys <file> --key <ed25519.key> --out <tar>
       [--skip-version-check] [--allow-foreign-signer] [--allow-test-build]
        build and sign a package; the binary is packed as sbx-agent
        (sbx-agent.exe for --os windows); it must report the version, the
        signing key must be in --update-keys and the binary must not be an
        integration test build (main.failRun, main.devUpdateKey)
  verify --keys <file> <tar>
        verify a package against an update keys file
`

// keyFileName is the private key file written by keygen.
const keyFileName = "ed25519.key"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run dispatches a subcommand and returns the exit code.
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = io.WriteString(stderr, usage)
		return 2
	}
	var err error
	switch args[0] {
	case "keygen":
		err = keygen(args[1:], stdout, stderr)
	case "pack":
		err = pack(args[1:], stdout, stderr)
	case "verify":
		err = verify(args[1:], stdout, stderr)
	default:
		_, _ = fmt.Fprintf(stderr, "sbx-release: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
	var ue usageError
	switch {
	case errors.As(err, &ue):
		_, _ = fmt.Fprintf(stderr, "sbx-release %s: %v\n\n%s", args[0], err, usage)
		return 2
	case err != nil:
		_, _ = fmt.Fprintf(stderr, "sbx-release %s: %v\n", args[0], err)
		return 1
	}
	return 0
}

// usageError marks bad command-line arguments.
type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

func newFlags(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	return fs
}

// keygen writes a new signing key to <dir>/ed25519.key (dir 0700, file
// 0600, never overwritten) and prints its public key line.
func keygen(args []string, stdout, stderr io.Writer) error {
	f := newFlags("keygen", stderr)
	out := f.String("out", "", "directory for ed25519.key")
	comment := f.String("comment", "", "comment of the public key line (default sbx-update-<date>)")
	if err := f.Parse(args); err != nil || *out == "" || f.NArg() != 0 {
		return usageError{"--out is required"}
	}
	if *comment == "" {
		*comment = "sbx-update-" + time.Now().UTC().Format("2006-01-02")
	}
	if err := os.MkdirAll(*out, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(*out, 0o700); err != nil {
		return err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	pemBytes, err := update.MarshalPrivateKey(priv)
	if err != nil {
		return err
	}
	path := filepath.Join(*out, keyFileName)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("%s exists; refusing to overwrite a signing key", path)
	}
	if err != nil {
		return err
	}
	if _, err := file.Write(pemBytes); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, update.FormatKey(pub, *comment))
	return err
}

// pack builds and signs a package.
func pack(args []string, stdout, stderr io.Writer) error {
	f := newFlags("pack", stderr)
	var o update.PackOptions
	var keyPath string
	f.StringVar(&o.Version, "version", "", "agent version")
	f.StringVar(&o.OS, "os", "", "GOOS of the binary")
	f.StringVar(&o.Arch, "arch", "", "GOARCH of the binary")
	f.StringVar(&o.Binary, "binary", "", "sbx-agent binary (sbx-agent.exe for --os windows)")
	f.StringVar(&o.TunnelCA, "tunnel-ca", "", "tunnel CA bundle (PEM)")
	f.StringVar(&o.UpdateKeys, "update-keys", "", "update keys file")
	f.StringVar(&keyPath, "key", "", "signing key (ed25519.key)")
	f.StringVar(&o.Out, "out", "", "package tar to write")
	skipVersion := f.Bool("skip-version-check", false, "do not run `<binary> version` (required when the binary is for another platform)")
	foreignSigner := f.Bool("allow-foreign-signer", false, "sign with a key that is not in --update-keys")
	testBuild := f.Bool("allow-test-build", false, "pack a binary built with the integration test ldflags (main.failRun, main.devUpdateKey)")
	if err := f.Parse(args); err != nil || f.NArg() != 0 {
		return usageError{"bad arguments"}
	}
	for name, v := range map[string]string{
		"--version": o.Version, "--os": o.OS, "--arch": o.Arch, "--binary": o.Binary,
		"--tunnel-ca": o.TunnelCA, "--update-keys": o.UpdateKeys, "--key": keyPath, "--out": o.Out,
	} {
		if v == "" {
			return usageError{name + " is required"}
		}
	}
	// The packed keys file must parse, or the installed version could not
	// verify its own updates.
	pinned, err := update.ReadKeys(o.UpdateKeys)
	if err != nil {
		return fmt.Errorf("%s: %w", o.UpdateKeys, err)
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}
	if o.Key, err = update.ParsePrivateKey(keyPEM); err != nil {
		return err
	}
	signer := o.Key.Public().(ed25519.PublicKey)
	if !slices.ContainsFunc(pinned, func(k ed25519.PublicKey) bool { return k.Equal(signer) }) {
		if !*foreignSigner {
			return fmt.Errorf("the signing key is not in %s; the installed version could not verify its next update (use --allow-foreign-signer to override)", o.UpdateKeys)
		}
		_, _ = fmt.Fprintf(stderr, "warning: the signing key is not in %s\n", o.UpdateKeys)
	}
	if err := checkTestBuild(o.Binary, *testBuild, stderr); err != nil {
		return err
	}
	if err := checkBinaryVersion(o, *skipVersion, stderr); err != nil {
		return err
	}
	m, err := update.Pack(o)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "%s: %s %s/%s\n", o.Out, m.Version, m.OS, m.Arch)
	return err
}

// testLDFlags are the -X variables of the integration test builds
// (cmd/sbx-agent/testaids.go); a release must not carry them.
var testLDFlags = []string{"main.failRun", "main.devUpdateKey"}

// testBuildFlags returns the test ldflags set in the build info of a binary.
func testBuildFlags(bi *debug.BuildInfo) []string {
	var found []string
	for _, s := range bi.Settings {
		if s.Key != "-ldflags" {
			continue
		}
		for _, v := range testLDFlags {
			if strings.Contains(s.Value, v+"=") {
				found = append(found, v)
			}
		}
	}
	return found
}

// checkTestBuild refuses a binary built with the test ldflags unless allow
// is set (then it warns). The flags are read from the Go build info, which
// also works for a binary of another platform; a binary without build info
// is packed with a warning.
func checkTestBuild(binary string, allow bool, stderr io.Writer) error {
	bi, err := buildinfo.ReadFile(binary)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "warning: cannot read the Go build info of %s (%v); not checking for test ldflags\n", binary, err)
		return nil
	}
	flags := testBuildFlags(bi)
	if len(flags) == 0 {
		return nil
	}
	if !allow {
		return fmt.Errorf("%s is a test build (ldflags set %s); pass --allow-test-build to pack it anyway", binary, strings.Join(flags, ", "))
	}
	_, _ = fmt.Fprintf(stderr, "warning: packing a test build (%s)\n", strings.Join(flags, ", "))
	return nil
}

// checkBinaryVersion makes sure `<binary> version` prints the package
// version: the agent finds out whether it is the target of a pending update
// by its compiled version. A binary for another platform cannot be run, so
// it needs skip (with a warning).
func checkBinaryVersion(o update.PackOptions, skip bool, stderr io.Writer) error {
	if skip {
		_, _ = fmt.Fprintf(stderr, "warning: not checking that %s reports version %s\n", o.Binary, o.Version)
		return nil
	}
	if o.OS != runtime.GOOS || o.Arch != runtime.GOARCH {
		return fmt.Errorf("the binary is for %s/%s and cannot be run here to check its version; pass --skip-version-check", o.OS, o.Arch)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, o.Binary, "version").Output()
	if err != nil {
		return fmt.Errorf("%s version: %w", o.Binary, err)
	}
	if got := strings.TrimSpace(string(out)); got != o.Version {
		return fmt.Errorf("%s reports version %q, want %q (build with -ldflags \"-X main.version=%s\")", o.Binary, got, o.Version, o.Version)
	}
	return nil
}

// verify checks a package against a keys file.
func verify(args []string, stdout, stderr io.Writer) error {
	f := newFlags("verify", stderr)
	keysPath := f.String("keys", "", "update keys file")
	if err := f.Parse(args); err != nil || *keysPath == "" || f.NArg() != 1 {
		return usageError{"want --keys <file> <tar>"}
	}
	keys, err := update.ReadKeys(*keysPath)
	if err != nil {
		return err
	}
	tmp, err := os.MkdirTemp("", "sbx-release-verify-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	dir := filepath.Join(tmp, "pkg")
	if err := update.Unpack(f.Arg(0), dir); err != nil {
		return err
	}
	m, err := update.Verify(dir, keys)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "ok: %s %s/%s created %s\n", m.Version, m.OS, m.Arch, m.CreatedAt.Format(time.RFC3339))
	return err
}
