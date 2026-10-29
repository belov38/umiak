package update

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/config"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/shimproto"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// SelfTestTimeout bounds `sbx-agent selftest` during an update (spec 17.4
// step 3).
const SelfTestTimeout = 10 * time.Second

// SelfTest is `sbx-agent selftest`: the version in versionDir (the
// directory of the running binary) checks that it can take over this
// machine. The config must parse, the trust files of the version must be
// present, schema (the state.db schema; 0 for none) must not be newer than
// store.SchemaVersion, and every shim protocol in shimProtos must be in
// [shimproto.MinVersion, shimproto.Version]. state.db itself is not opened:
// the running agent holds its lock.
func SelfTest(l paths.Layout, versionDir string, schema int, shimProtos []int) error {
	var errs []error
	if _, err := config.Load(l.ConfigFile); err != nil {
		errs = append(errs, err)
	}
	if fi, err := os.Stat(filepath.Join(versionDir, filepath.FromSlash(TunnelCAName))); err != nil {
		errs = append(errs, fmt.Errorf("trust: %w", err))
	} else if !fi.Mode().IsRegular() {
		errs = append(errs, fmt.Errorf("trust: %s is not a regular file", TunnelCAName))
	}
	if _, err := ReadKeys(filepath.Join(versionDir, filepath.FromSlash(UpdateKeysName))); err != nil {
		errs = append(errs, fmt.Errorf("trust: %w", err))
	}
	if schema < 0 || schema > store.SchemaVersion {
		errs = append(errs, fmt.Errorf("state.db schema %d is not supported (max %d)", schema, store.SchemaVersion))
	}
	for _, p := range shimProtos {
		if p < shimproto.MinVersion || p > shimproto.Version {
			errs = append(errs, fmt.Errorf("shim protocol %d is not supported (%d..%d)", p, shimproto.MinVersion, shimproto.Version))
		}
	}
	return errors.Join(errs...)
}

// ParseProtos parses a comma-separated list of shim protocol versions.
func ParseProtos(s string) ([]int, error) {
	var out []int
	for _, f := range strings.Split(s, ",") {
		if f = strings.TrimSpace(f); f == "" {
			continue
		}
		n, err := strconv.Atoi(f)
		if err != nil {
			return nil, fmt.Errorf("update: bad shim protocol %q", f)
		}
		out = append(out, n)
	}
	return out, nil
}

// FormatProtos is the inverse of ParseProtos.
func FormatProtos(protos []int) string {
	parts := make([]string, len(protos))
	for i, p := range protos {
		parts[i] = strconv.Itoa(p)
	}
	return strings.Join(parts, ",")
}

// ExecSelfTest runs `<bin> selftest --schema <schema> --shim-protos <list>`
// within SelfTestTimeout and returns its output in the error.
func ExecSelfTest(ctx context.Context, bin string, schema int, shimProtos []int) error {
	ctx, cancel := context.WithTimeout(ctx, SelfTestTimeout)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, bin, "selftest", "--schema", strconv.Itoa(schema), "--shim-protos", FormatProtos(shimProtos))
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("selftest: %w: %s", err, strings.TrimSpace(out.String()))
	}
	return nil
}
