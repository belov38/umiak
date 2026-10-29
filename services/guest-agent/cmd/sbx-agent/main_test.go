package main

import (
	"bytes"
	"runtime"
	"strings"
	"testing"
)

func TestRun(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantCode int
		wantOut  string
		wantErr  string
	}{
		{"no args", nil, 2, "", "usage"},
		{"unknown", []string{"bogus"}, 2, "", "usage"},
		{"version", []string{"version"}, 0, "dev", ""},
		{"identity without apply", []string{"identity"}, 2, "", "usage"},
		{"identity bad action", []string{"identity", "x"}, 2, "", "usage"},
		{"run", []string{"run"}, 1, "", "not implemented"},
		{"shim without id", []string{"shim"}, shimUsageCode(), "", shimUsageErr()},
		{"quiesce-watchdog without lease", []string{"quiesce-watchdog"}, 2, "", "usage: sbx-agent quiesce-watchdog --lease"},
		{"quiesce-watchdog extra arg", []string{"quiesce-watchdog", "--lease", "x", "y"}, 2, "", "usage"},
		{"rollback", []string{"rollback"}, 1, "", "not implemented"},
		{"doctor", []string{"doctor"}, 1, "", "not implemented"},
		{"thaw without force", []string{"thaw"}, 2, "", "usage: sbx-agent thaw --force"},
		{"install-package", []string{"install-package"}, 1, "", "not implemented"},
		{"selftest", []string{"selftest"}, 1, "", "not implemented"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			code := run(tt.args, &out, &errOut)
			if code != tt.wantCode {
				t.Errorf("exit = %d, want %d", code, tt.wantCode)
			}
			if !strings.Contains(out.String(), tt.wantOut) {
				t.Errorf("stdout = %q, want to contain %q", out.String(), tt.wantOut)
			}
			if !strings.Contains(errOut.String(), tt.wantErr) {
				t.Errorf("stderr = %q, want to contain %q", errOut.String(), tt.wantErr)
			}
		})
	}
}

// shimUsageCode is the exit code of `sbx-agent shim` without --id: a usage
// error on Linux, "unsupported" elsewhere.
func shimUsageCode() int {
	if runtime.GOOS == "linux" {
		return 2
	}
	return 1
}

// shimUsageErr is what `sbx-agent shim` without --id prints.
func shimUsageErr() string {
	if runtime.GOOS == "linux" {
		return "usage: sbx-agent shim --id"
	}
	return "unsupported"
}
