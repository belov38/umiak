package main

import (
	"context"

	"github.com/belov38/umiak/services/guest-agent/internal/config"
	"github.com/belov38/umiak/services/guest-agent/internal/ident"
)

// Build-time test aids. Production builds leave both variables empty; only
// the Linux integration tests (test/linux/run.sh) set them with -ldflags -X.
// Nothing at run time (environment, files) can change them.
var (
	// failRun "1" makes `umiak-agent run` exit 1 at once while every other
	// command works: a package that passes selftest but cannot run, for the
	// rollback test (spec 21 item 3).
	failRun string
	// devUpdateKey is the base64 of an ed25519 public key that verifies the
	// first installed package next to the pinned keys: the integration
	// tests sign their packages with a key generated per run.
	devUpdateKey string
)

// testAids names the build-time test aids of d for doctor.
func (d deps) testAids() []string {
	var out []string
	if d.failRun {
		out = append(out, "failRun")
	}
	if d.devKey {
		out = append(out, "devUpdateKey")
	}
	return out
}

// embeddedKeys returns the pinned update keys file with devKey appended as
// one more key line when it is set.
func embeddedKeys(pinned []byte, devKey string) []byte {
	if devKey == "" {
		return pinned
	}
	out := append([]byte(nil), pinned...)
	if len(out) > 0 && out[len(out)-1] != '\n' {
		out = append(out, '\n')
	}
	return append(out, "ed25519 "+devKey+" dev-build-key\n"...)
}

// identityDir returns the smbios directory: [identity] sysfs_dir of
// agent.toml, or the sysfs default when the file is absent or invalid.
func identityDir(configFile string) string {
	cfg, err := config.Load(configFile)
	if err != nil {
		return config.DefaultIdentityDir
	}
	return cfg.IdentityDir
}

// configuredSource reads the smbios identity from the directory configured
// in agent.toml, re-reading the file on every Read.
type configuredSource struct {
	configFile string
	bootIDPath string
}

// Read implements ident.Source.
func (s configuredSource) Read(ctx context.Context) (ident.Raw, error) {
	return ident.SysfsSource{Dir: identityDir(s.configFile), BootIDPath: s.bootIDPath}.Read(ctx)
}
