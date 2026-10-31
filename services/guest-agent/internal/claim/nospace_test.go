package claim

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"

	"connectrpc.com/connect"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
)

// failWrites makes the Manager's file writes to path fail with errno, as a
// full disk or tmpfs would.
func failWrites(m *Manager, path string, errno syscall.Errno) {
	m.writeFile = func(p string, data []byte, perm fs.FileMode) error {
		if p == path {
			return &fs.PathError{Op: "write", Path: p, Err: errno}
		}
		return fsutil.WriteFileAtomic(p, data, perm)
	}
}

func TestClaimNoSpace(t *testing.T) {
	for _, tc := range []struct {
		name  string
		path  func(h *harness) string
		errno syscall.Errno
		// skip is why the file is not written through the writeFile seam
		// on this OS, or "".
		skip string
	}{
		{"sbx env", func(h *harness) string { return h.l.SbxEnvFile }, syscall.ENOSPC, onWindows("no /etc/sbx/env")},
		{"secret file", func(h *harness) string { return filepath.Join(h.l.SecretFilesDir, "key.pem") }, syscall.ENOSPC,
			onWindows("secret files are created with their ACL, not through writeFile")},
		{"secrets env", func(h *harness) string { return h.l.SecretsEnvFile }, syscall.ENOSPC, onWindows("the secret env stays in memory")},
		{"secrets state", func(h *harness) string { return h.l.SecretsStateFile }, syscall.EDQUOT, ""},
		{"ssh ca", func(h *harness) string { return h.l.SSHUserCA }, syscall.ENOSPC, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.skip != "" {
				t.Skip(tc.skip)
			}
			h := newHarness(t)
			failWrites(h.m, tc.path(h), tc.errno)
			_, err := h.m.Claim(context.Background(), fullRequest())
			wantDetail(t, err, connect.CodeResourceExhausted, errs.NoSpace)
		})
	}
}

// onWindows returns why on Windows, "" elsewhere.
func onWindows(why string) string {
	if runtime.GOOS == "windows" {
		return why
	}
	return ""
}

func TestClaimHostnameNoSpace(t *testing.T) {
	h := newHarness(t)
	h.m.opts.Hostname = func(string) error {
		return fmt.Errorf("claim: write hostname: %w", &fs.PathError{Op: "write", Path: "/etc/hostname", Err: syscall.ENOSPC})
	}
	_, err := h.m.Claim(context.Background(), fullRequest())
	wantDetail(t, err, connect.CodeResourceExhausted, errs.NoSpace)
}

func TestUpdatesNoSpace(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	if _, err := h.m.Claim(ctx, fullRequest()); err != nil {
		t.Fatal(err)
	}

	// Windows has no /etc/sbx/env: UpdateEnv writes no file there.
	if h.l.SbxEnvFile != "" {
		failWrites(h.m, h.l.SbxEnvFile, syscall.ENOSPC)
		_, err := h.m.UpdateEnv(ctx, &agentv1.UpdateEnvRequest{Env: map[string]string{"A": "b"}})
		wantDetail(t, err, connect.CodeResourceExhausted, errs.NoSpace)
	}

	failWrites(h.m, h.l.SecretsStateFile, syscall.ENOSPC)
	_, err := h.m.UpdateSecrets(ctx, &agentv1.UpdateSecretsRequest{SecretEnv: map[string]string{"TOKEN": "x"}})
	wantDetail(t, err, connect.CodeResourceExhausted, errs.NoSpace)

	failWrites(h.m, h.l.SSHUserCA, syscall.EDQUOT)
	_, err = h.m.UpdateSshCa(ctx, &agentv1.UpdateSshCaRequest{Keys: []string{"ssh-ed25519 AAAAx x"}})
	wantDetail(t, err, connect.CodeResourceExhausted, errs.NoSpace)
}

func TestStoreErrorNoSpace(t *testing.T) {
	err := storeError(fmt.Errorf("store: commit: %w", &os.PathError{Op: "write", Path: "state.db", Err: syscall.ENOSPC}))
	wantDetail(t, err, connect.CodeResourceExhausted, errs.NoSpace)
	err = storeError(fmt.Errorf("store: commit: %w", os.ErrClosed))
	wantDetail(t, err, connect.CodeInternal, errs.Internal)
}

func TestInternalKeepsConnectError(t *testing.T) {
	inner := internal("write secret", &fs.PathError{Op: "write", Path: "x", Err: syscall.ENOSPC})
	err := internal("prepare secrets", fmt.Errorf("claim: %w", inner))
	wantDetail(t, err, connect.CodeResourceExhausted, errs.NoSpace)
}
