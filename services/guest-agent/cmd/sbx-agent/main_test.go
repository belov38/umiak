package main

import (
	"bytes"
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
		{"shim", []string{"shim", "id"}, 1, "", "not implemented"},
		{"identity apply", []string{"identity", "apply"}, 1, "", "not implemented"},
		{"quiesce-watchdog", []string{"quiesce-watchdog"}, 1, "", "not implemented"},
		{"rollback", []string{"rollback"}, 1, "", "not implemented"},
		{"doctor", []string{"doctor"}, 1, "", "not implemented"},
		{"thaw", []string{"thaw"}, 1, "", "not implemented"},
		{"install-package", []string{"install-package"}, 1, "", "not implemented"},
		{"seal", []string{"seal"}, 1, "", "not implemented"},
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
