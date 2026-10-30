package shim

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadSpecDeletes(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c1")
	if err := os.WriteFile(p, []byte(`{"id":"c1","argv":["/bin/true"],"env":["A=1"],"pty":{"cols":80,"rows":24}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := ReadSpec(p)
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "c1" || len(s.Argv) != 1 || s.PTY == nil || s.PTY.Cols != 80 || s.Env[0] != "A=1" {
		t.Errorf("spec = %+v", s)
	}
	if _, err := os.Stat(p); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("spec file not deleted: %v", err)
	}
}

func TestReadSpecBadJSONDeletes(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c1")
	if err := os.WriteFile(p, []byte(`{`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadSpec(p); err == nil {
		t.Error("want a parse error")
	}
	if _, err := os.Stat(p); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("spec file not deleted: %v", err)
	}
}

func TestSpecValidate(t *testing.T) {
	tests := []struct {
		name string
		s    Spec
		ok   bool
	}{
		{"ok", Spec{ID: "c1", Argv: []string{"true"}}, true},
		{"id mismatch", Spec{ID: "c2", Argv: []string{"true"}}, false},
		{"no argv", Spec{ID: "c1"}, false},
		{"empty program", Spec{ID: "c1", Argv: []string{""}}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.s.validate("c1"); (err == nil) != tt.ok {
				t.Errorf("validate = %v, want ok %v", err, tt.ok)
			}
		})
	}
}

func TestReadSpecFrom(t *testing.T) {
	in := `{"id":"c1","argv":["cmd","/c","exit 3"],"env":["A=1"],"user":"SYSTEM","desktop":true,"script":"exit 7"}`
	s, err := ReadSpecFrom(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "c1" || len(s.Argv) != 3 || s.User != "SYSTEM" || !s.Desktop || s.Script != "exit 7" {
		t.Errorf("spec = %+v", s)
	}
	if _, err := ReadSpecFrom(strings.NewReader(`{`)); err == nil {
		t.Error("want a parse error")
	}
	if _, err := ReadSpecFrom(strings.NewReader("")); err == nil {
		t.Error("want an error for an empty spec")
	}
}
