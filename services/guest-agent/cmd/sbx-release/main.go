// Command sbx-release builds and checks signed sbx-agent packages (spec S3
// section 17.3, decision 8).
//
//	sbx-release keygen --out <dir> [--comment c]
//	sbx-release pack --version v --os linux --arch amd64 --binary <path> \
//	    --tunnel-ca <pem> --update-keys <file> --key <ed25519.key> --out <tar>
//	sbx-release verify --keys <file> <tar>
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

const usage = `usage: sbx-release <command>

commands:
  keygen --out <dir> [--comment c]
        write <dir>/ed25519.key (0600) and print the public key line
  pack --version v --os linux --arch amd64 --binary <path> --tunnel-ca <pem>
       --update-keys <file> --key <ed25519.key> --out <tar>
        build and sign a package
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
	f.StringVar(&o.Binary, "binary", "", "sbx-agent binary")
	f.StringVar(&o.TunnelCA, "tunnel-ca", "", "tunnel CA bundle (PEM)")
	f.StringVar(&o.UpdateKeys, "update-keys", "", "update keys file")
	f.StringVar(&keyPath, "key", "", "signing key (ed25519.key)")
	f.StringVar(&o.Out, "out", "", "package tar to write")
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
	if _, err := update.ReadKeys(o.UpdateKeys); err != nil {
		return fmt.Errorf("%s: %w", o.UpdateKeys, err)
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}
	if o.Key, err = update.ParsePrivateKey(keyPEM); err != nil {
		return err
	}
	m, err := update.Pack(o)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "%s: %s %s/%s\n", o.Out, m.Version, m.OS, m.Arch)
	return err
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
